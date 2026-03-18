/**
 * Channels 模块
 * 统一消息渠道抽象层
 *
 * @module src/channels
 */

export {
    Channel,
    ChannelManager,
    channelManager,
    type ChannelMessage,
    type MessageHandler,
    type AlertAction,
    type SendOptions,
    type AlertOptions,
    type ReplyResult,
} from './base';

export { LarkChannel, larkChannel } from './lark';
export { WebSocketChannel, webSocketChannel, clearTokenBuffer } from './websocket';
