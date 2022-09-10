import bridge, { genericPromiseError, configFile, manageMsgCache } from './bridge';
import { conjoinedMsg, twitchMsg } from '../messageObjects';
import { authenticateTwitch, AuthResponse } from '../oauth';
import { Message } from 'discord.js';
import { promises as fs } from 'fs';
import { RefreshingAuthProvider } from '@twurple/auth';
import { PrivateMessage } from '@twurple/chat';
import { ChatClient } from '@twurple/chat';
import { linkedListNode } from 'src/linkedList';


//Twitch init
/////////////

function registerTwitch(): void
{
    /**
    * Login to twitch using the access token found in our oauth process
    */
    async function loginToTwitch(): Promise<void>
    {
        //TODO: detect replies by looking at previously recorded messages (userState["reply-parent-msg-id"])
        let tokenData: AuthResponse;

        try
        {
            if(configFile.DEV_TWITCH_TOKEN)
            {
                tokenData = JSON.parse(await fs.readFile('./tokens.json', 'utf-8'));
                console.log('Using saved token data found in ./tokens.json');
            }
        }
        catch(error: unknown)
        {
            // The only way for an error to be thrown here is if we try to read tokens.json and it 
            // doesn't exist, which will only happen if we have
            // DEV_TWITCH_TOKEN enabled, so it's safe to just write to tokens.json
            const res: AuthResponse = await authenticateTwitch({
                scope: configFile.T2D_SCOPE,
                redirect_uri: configFile.T2D_REDIRECT_URI,
                client_id: configFile.T2D_CLIENT_ID,
                client_secret: configFile.T2D_SECRET,
                use_https: configFile.T2D_HTTPS.enabled
            });

            await fs.writeFile('./tokens.json', JSON.stringify(res));
            console.log('Saved token data.');

            loginToTwitch();
            return;
        }

        // If bad data is given to our auth provider you'll get a log along the lines of "no valid token avaiable; trying to refresh.." etc.
        const authProvider: RefreshingAuthProvider = new RefreshingAuthProvider(
            {
                'clientId': configFile.T2D_CLIENT_ID,
                'clientSecret': configFile.T2D_SECRET,
                onRefresh: async newTokenData => configFile.DEV_TWITCH_TOKEN ? await fs.writeFile('./tokens.json', JSON.stringify(newTokenData, null, 4), 'utf-8') : null
            },
            tokenData! as any || await authenticateTwitch({
                scope: configFile.T2D_SCOPE,
                redirect_uri: configFile.T2D_REDIRECT_URI,
                client_id: configFile.T2D_CLIENT_ID,
                client_secret: configFile.T2D_SECRET,
                use_https: configFile.T2D_HTTPS.enabled
            })
        );

        bridge.twitch.authChatClient = new ChatClient({ authProvider, channels: [configFile.T2D_CHANNELS[0]] });
        bridge.twitch.anonChatClient = new ChatClient({ authProvider: undefined, channels: [configFile.T2D_CHANNELS[0]] });

        //TODO: if we need to scale this to *much* more than just one twitch channel, this won't be usable, there will need to be another approach to record the ID's of the bot user
        bridge.twitch.authChatClient.connect().then(() =>
            console.log('Authenticated Twitch Client has connected')
        );

        bridge.twitch.anonChatClient.connect().then(() =>
            console.log('Anon Twitch Client has connected')
        );

        // Using anonChatClient so that we recieve the messages we send, yknow.
        bridge.twitch.anonChatClient.onMessage((channel: string, user: string, message: string, userState: PrivateMessage) =>
        {
            if(!bridge.targetDiscordChannel)
                throw new Error('Cannot find Discord channel.');

            /**
                    'reply-parent-display-name': 'testingaccount__',
                    'reply-parent-msg-body': 'test',
                    'reply-parent-msg-id': 'f279b175-7100-4486-bb96-c188ea102bbd',
                    'reply-parent-user-id': '821973125',
  '                 'reply-parent-user-login': 'testingaccount__',

                    Those keys will exist on the userState.tags (Map<String, String>) map, if it
                    is a reply.
            */

            // if there is a reply parent display name
            // we know it's a reply.
            if(userState.tags.get('reply-parent-display-name'))
            {
                // get the linked list node from the Twitch ID that was replied to
                const fetchedNode: linkedListNode<conjoinedMsg> = bridge.discordTwitchCacheMap.get(userState.tags.get('reply-parent-msg-id'));

                if(!fetchedNode)
                    return;

                try
                {
                    fetchedNode.data!.message!.reply(`[t][ ${ user } ] ${ message }`);
                    return;
                }
                catch(err: unknown)
                {
                    console.error(`Failed to reply to Discord message (ID %d)\nError: ${ err }`, fetchedNode.data!.message!.id);
                }
            }

            // If the person who sent the message's name isn't equal to the bot's name
            // then send the Discord message.
            if(!(configFile.T2D_BOT_USERNAME.toLowerCase() === user.toLowerCase()))
                // We should (hopefully) not get stuck in a loop here due to our
                // checks in discord.ts
                bridge.targetDiscordChannel.send(`[t][${ user }] ${ message }`).then((discordMessage: Message<boolean>) =>
                {
                    //Discord actually stores message object after the promise is fullfilled (unlike twitch), so we can just create this object on the fly

                    //Map both of these results for later querying. Eventually these will go away as we're deleting messages we don't care about anymore.
                    const twitchMessage = new twitchMsg(message, false, userState, channel);
                    const listNode = bridge.messageLinkdListInterface.addNode(new conjoinedMsg(discordMessage, [twitchMessage]));

                    bridge.discordTwitchCacheMap.set(twitchMessage, listNode);
                    bridge.discordTwitchCacheMap.set(twitchMessage.userState.id, listNode);
                    bridge.discordTwitchCacheMap.set(discordMessage, listNode);

                    //Count upwards and delete the oldest message if need be
                    manageMsgCache();
                }, genericPromiseError);

            if(bridge.twitchMessageSearchCache[message])
            {
                const existingNode = bridge.twitchMessageSearchCache[message],
                    twitchMessage = new twitchMsg(message, true, userState, channel);

                existingNode.data!.twitchArray.push(twitchMessage);
                bridge.discordTwitchCacheMap.set(twitchMessage, existingNode);
                bridge.discordTwitchCacheMap.set(twitchMessage.userState.id, existingNode);

                //Remove this from the cache since we found it
                delete bridge.twitchMessageSearchCache[message];
            }
        });
    }

    //Login to twitch
    //There are a lot of things that were named differently because this command has the potential of using environemnt variables, so this will be painful to look at and I'm sorry XP
    loginToTwitch();
}

export default registerTwitch;