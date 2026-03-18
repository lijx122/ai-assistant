// 临时脚本：为测试消息生成 embedding
import { getDb } from './src/db/index.ts';
import { indexMessage } from './src/services/message-indexer.ts';

const MESSAGE_ID = '2e72b8e7-939d-45e6-9882-0295a7017223';
const WORKSPACE_ID = '0b30d46ff4abfde770051a0bf724cff4';
const SESSION_ID = 'd316ed8c-0dd5-4d21-8bf0-eab8441c5c71';
const CONTENT = '"最近在写一个nanobot改版"';

async function main() {
  console.log('Indexing test message...');
  await indexMessage(MESSAGE_ID, WORKSPACE_ID, SESSION_ID, CONTENT, 'user');
  console.log('Done!');
}

main().catch(console.error);
