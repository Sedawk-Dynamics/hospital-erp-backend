import axios from 'axios';

// Local/self-hosted embedding model used for CDSS guideline RAG.
// The SAME model must embed both the stored chunks and the query, so this is the
// single definition shared by the ingestion script and the retrieval at query time.
// URL is env-configurable: localhost in dev, the Ollama container URL in prod.
const OLLAMA_URL = process.env.OLLAMA_URL ?? 'http://localhost:11434';
const EMBED_MODEL = 'nomic-embed-text';
const EMBED_DIMS = 768;

/** Turn text into a 768-dim embedding via Ollama (nomic-embed-text). */
export async function embedText(text: string): Promise<number[]> {
  const res = await axios.post(`${OLLAMA_URL}/api/embeddings`, {
    model: EMBED_MODEL,
    prompt: text,
  });
  const vector = res.data.embedding as number[];
  if (!Array.isArray(vector) || vector.length !== EMBED_DIMS) {
    throw new Error(`Expected ${EMBED_DIMS} dims, got ${vector?.length ?? 0}`);
  }
  return vector;
}
