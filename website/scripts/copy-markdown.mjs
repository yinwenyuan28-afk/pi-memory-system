import { cp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const websiteDir = fileURLToPath(new URL('../', import.meta.url));
const distDir = path.join(websiteDir, '.vitepress', 'dist');
const markdownDir = path.join(distDir, '_markdown');

async function copyMarkdownTree(sourceDir, targetDir) {
  const entries = await readdir(sourceDir, { withFileTypes: true });

  for (const entry of entries) {
    const source = path.join(sourceDir, entry.name);
    const target = path.join(targetDir, entry.name);

    if (entry.isDirectory()) {
      await copyMarkdownTree(source, target);
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      await mkdir(path.dirname(target), { recursive: true });
      await cp(source, target);
    }
  }
}

await rm(markdownDir, { recursive: true, force: true });
await mkdir(markdownDir, { recursive: true });

// The homepage is rendered from a Vue component, so keep a concise Markdown
// equivalent for agents. Documentation pages are copied from their sources.
await cp(path.join(websiteDir, 'agent-content', 'zh-home.md'), path.join(markdownDir, 'index.md'));
await cp(path.join(websiteDir, 'agent-content', 'en-home.md'), path.join(markdownDir, 'en', 'index.md'));
await copyMarkdownTree(path.join(websiteDir, 'docs'), path.join(markdownDir, 'docs'));
await copyMarkdownTree(path.join(websiteDir, 'en', 'docs'), path.join(markdownDir, 'en', 'docs'));

console.log('Copied VitePress pages to the internal Markdown asset directory.');
