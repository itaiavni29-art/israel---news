// Local sentence embeddings via transformers.js (ONNX runtime, CPU). No API, no cost.
// The model is downloaded once from Hugging Face into ./models and then runs offline.
import path from 'node:path';
import { pipeline, env } from '@huggingface/transformers';
import { ROOT } from './config.js';
import { cleanTitle } from './text.js';

env.cacheDir = path.join(ROOT, 'models');

// E5 models are trained with a task prefix; "query: " is the recommended one for symmetric similarity.
const PREFIX = { 'multilingual-e5': 'query: ' };
const prefixFor = model => Object.entries(PREFIX).find(([k]) => model.includes(k))?.[1] ?? '';

export class Embedder {
  constructor(model, { dtype = 'q8' } = {}) {
    this.model = model;
    this.dtype = dtype;
    this.prefix = prefixFor(model);
    this.cache = new Map(); // cleaned title -> Float32Array
    this.ready = null;
  }

  load() {
    this.ready ??= pipeline('feature-extraction', this.model, { dtype: this.dtype });
    return this.ready;
  }

  /** @param {string[]} titles raw headlines → unit-length vectors (same order) */
  async embed(titles) {
    const extractor = await this.load();
    const cleaned = titles.map(cleanTitle);
    const missing = [...new Set(cleaned.filter(t => !this.cache.has(t)))];
    for (let i = 0; i < missing.length; i += 32) {
      const batch = missing.slice(i, i + 32);
      const out = await extractor(batch.map(t => this.prefix + t), { pooling: 'mean', normalize: true });
      const dim = out.dims[1];
      batch.forEach((t, j) => this.cache.set(t, out.data.slice(j * dim, (j + 1) * dim)));
    }
    if (this.cache.size > 20000) this.cache.clear(); // bounded memory for long-running servers
    return cleaned.map(t => this.cache.get(t));
  }
}

export function cosine(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}
