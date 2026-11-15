export {
  EMBEDDING_DIM,
  stemWord,
  tokenize,
  embedText,
  cosineSimilarity,
  createHttpEmbedder,
  type HttpEmbedderOptions
} from './vectorStore/embeddings.js';
export {
  VectorStore,
  type VectorDocument,
  type VectorUpsertItem,
  type VectorSearchResult
} from './vectorStore/jsonStore.js';
export { SQLiteVectorStore } from './vectorStore/sqliteStore.js';
