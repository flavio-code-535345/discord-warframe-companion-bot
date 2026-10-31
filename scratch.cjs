const fs=require('fs');const f='src/wiki/index.ts';let s=fs.readFileSync(f,'utf8');
const rep=(a,b)=>{if(!s.includes(a))throw new Error('missing: '+a.slice(0,70));s=s.replace(a,b);};
rep(`/** Kept passage vectors (about 3 KB each); the oldest are dropped past this. */
const MAX_VECTORS = 30_000;
const VECTOR_PRUNE_EXTRA = 3_000;
`,'');
rep(`      CREATE TABLE IF NOT EXISTS embeddings (hash TEXT PRIMARY KEY, vec BLOB NOT NULL, at INTEGER NOT NULL);
`,`      DROP TABLE IF EXISTS embeddings;
`);
const a=s.indexOf('  // --- embeddings (see embed.ts)');const b=s.indexOf('  private chunksOf(title: string)');
if(a<0||b<0)throw new Error('range');s=s.slice(0,a)+s.slice(b);
fs.writeFileSync(f,s);
