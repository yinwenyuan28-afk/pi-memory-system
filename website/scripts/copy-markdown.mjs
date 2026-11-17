import { cp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const websiteDir = fileURLToPath(new URL('../', import.meta.url));
const distDir = path.join(websiteDir, '.vitepress', 'dist');
const markdownDir = path.join(distDir, '_markdown');

/** 用途：递归复制指定公开页面树到内部 Markdown 资源目录，保留相对路由。 */
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

// 用途：项目介绍与教程也支持生产 Worker 的 Accept: text/markdown 内容协商。
await copyMarkdownTree(path.join(websiteDir, 'projects'), path.join(markdownDir, 'projects'));
await copyMarkdownTree(path.join(websiteDir, 'en', 'projects'), path.join(markdownDir, 'en', 'projects'));

console.log('Copied VitePress pages to the internal Markdown asset directory.');
