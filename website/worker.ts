interface AssetBinding {
  fetch(request: Request): Promise<Response>;
}

interface Env {
  ASSETS: AssetBinding;
}

function acceptsMarkdown(header: string | null): boolean {
  if (!header) return false;

  return header.split(',').some((part) => {
    const [mediaType, ...parameters] = part.trim().split(';');
    if (mediaType?.trim().toLowerCase() !== 'text/markdown') return false;

    const quality = parameters
      .map((parameter) => parameter.trim().match(/^q\s*=\s*(.+)$/i)?.[1])
      .find((value) => value !== undefined);
    return quality === undefined || Number(quality) > 0;
  });
}

function markdownAssetPaths(pathname: string): string[] {
  let route = pathname.replace(/\/+$/, '');
  if (!route) route = '/index';
  if (/\.html?$/i.test(route)) route = route.replace(/\.html?$/i, '');
  if (/\.md$/i.test(route)) route = route.replace(/\.md$/i, '');

  const pagePath = `/_markdown${route}.md`;
  const indexPath = `/_markdown${route}/index.md`;
  return pagePath === indexPath ? [pagePath] : [pagePath, indexPath];
}

function addVaryAccept(response: Response): Response {
  const headers = new Headers(response.headers);
  const vary = headers.get('Vary')?.split(',').map((value) => value.trim()) ?? [];
  if (!vary.some((value) => value.toLowerCase() === 'accept')) vary.push('Accept');
  headers.set('Vary', vary.filter(Boolean).join(', '));

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Markdown source copies are an internal implementation detail, not public URLs.
    if (url.pathname.startsWith('/_markdown/')) {
      return new Response('Not Found', { status: 404 });
    }

    if (
      (request.method === 'GET' || request.method === 'HEAD') &&
      acceptsMarkdown(request.headers.get('Accept'))
    ) {
      for (const assetPath of markdownAssetPaths(url.pathname)) {
        const markdownUrl = new URL(request.url);
        markdownUrl.pathname = assetPath;
        const markdownResponse = await env.ASSETS.fetch(new Request(markdownUrl));
        if (markdownResponse.status !== 200) continue;

        const headers = new Headers(markdownResponse.headers);
        headers.set('Content-Type', 'text/markdown; charset=utf-8');
        const vary = headers.get('Vary')?.split(',').map((value) => value.trim()) ?? [];
        if (!vary.some((value) => value.toLowerCase() === 'accept')) vary.push('Accept');
        headers.set('Vary', vary.filter(Boolean).join(', '));

        const body = request.method === 'HEAD' ? null : await markdownResponse.text();
        return new Response(body, { status: 200, headers });
      }
    }

    return addVaryAccept(await env.ASSETS.fetch(request));
  }
};
