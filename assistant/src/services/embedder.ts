/**
 * Embedder 模块
 * 使用 Xenova/bge-small-zh-v1.5 生成文本向量
 *
 * @module src/services/embedder
 */

const MODEL = 'Xenova/bge-small-zh-v1.5';
const IDLE_TIMEOUT = 30 * 60 * 1000; // 30分钟空闲卸载

let extractor: any = null;
let idleTimer: NodeJS.Timeout | null = null;
let isLoading = false; // 模型加载中标志，用于快速失败降级
type TransformersModule = typeof import('@xenova/transformers');
let transformersModulePromise: Promise<TransformersModule> | null = null;

function loadTransformers(): Promise<TransformersModule> {
  if (!transformersModulePromise) {
    const dynamicImport = new Function('s', 'return import(s)') as (s: string) => Promise<TransformersModule>;
    transformersModulePromise = dynamicImport('@xenova/transformers');
  }
  return transformersModulePromise;
}

/**
 * 重置空闲定时器
 */
function resetIdleTimer() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    extractor = null;
    idleTimer = null;
    console.log('[Embedder] Model unloaded after 30min idle');
  }, IDLE_TIMEOUT);
}

/**
 * 获取或初始化 pipeline
 * 如果模型正在加载中，立即抛出错误以便调用方降级
 */
async function getExtractor() {
  // 快速失败：如果模型正在加载中，不阻塞等待，让调用方降级
  if (isLoading) {
    throw new Error('Model loading in progress');
  }

  if (!extractor) {
    isLoading = true;
    try {
      console.log('[Embedder] Loading model bge-small-zh-v1.5...');
      const { pipeline } = await loadTransformers();
      extractor = await pipeline('feature-extraction', MODEL, {
        quantized: true // 使用量化模型减少内存占用
      });
      console.log('[Embedder] Model loaded');
    } finally {
      isLoading = false;
    }
  }
  resetIdleTimer();
  return extractor;
}

/**
 * 生成文本的 embedding 向量
 * @param text 输入文本
 * @returns Float32Array 向量（384维）
 */
export async function embed(text: string): Promise<Float32Array> {
  const ext = await getExtractor();
  const output = await ext(text, { pooling: 'mean', normalize: true });
  return output.data as Float32Array;
}

/**
 * 预加载模型（启动时调用，不阻塞）
 */
export async function preload(): Promise<void> {
  await getExtractor();
}

/**
 * 手动卸载模型（可选，进程退出自动清理）
 */
export function unload(): void {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  extractor = null;
  console.log('[Embedder] Model manually unloaded');
}

/**
 * 计算两个向量的余弦相似度
 * @param a Float32Array
 * @param b Float32Array
 * @returns 相似度分数 [-1, 1]，通常 [0, 1]
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * 批量计算相似度（优化内存访问）
 */
export function cosineSimilarityBatch(
  queryVec: Float32Array,
  candidates: Float32Array[]
): number[] {
  return candidates.map(candidate => cosineSimilarity(queryVec, candidate));
}
