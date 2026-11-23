export default {
  async fetch(request, env) {
    const expected = new TextEncoder().encode('Bearer ' + env.PULL_SECRET);
    const offered = new TextEncoder().encode(request.headers.get('Authorization') || '');
    if (!env.PULL_SECRET || expected.length !== offered.length ||
        !crypto.subtle.timingSafeEqual(expected, offered)) return new Response(null, { status: 401 });
    const url = new URL(request.url);
    if (url.pathname === '/mail' && request.method === 'GET') {
      const page = await env.STAGING.list({ prefix:'mail/', limit:25, cursor:url.searchParams.get('cursor') || undefined });
      return Response.json({ keys:page.objects.map(item=>item.key), cursor:page.truncated ? page.cursor : null });
    }
    const key = url.pathname.slice(1);
    if (!/^mail\/[0-9a-f-]{36}$/.test(key)) return new Response(null, { status: 404 });
    if (request.method === 'GET') {
      const item=await env.STAGING.get(key);
      if (!item) return new Response(null, { status: 404 });
      return new Response(item.body,{ headers:{
        'content-type':'application/octet-stream','cache-control':'no-store',
        'x-letterdock-from':encodeURIComponent(item.customMetadata?.from ?? ''),
        'x-letterdock-to':encodeURIComponent(item.customMetadata?.to ?? '')
      }});
    }
    if (request.method === 'DELETE') {
      await env.STAGING.delete(key);
      return new Response(null, { status: 204 });
    }
    return new Response(null, { status: 405 });
  },

  async email(message, env) {
    const id = crypto.randomUUID();
    try {
      const stream = new FixedLengthStream(message.rawSize);
      await Promise.all([
        message.raw.pipeTo(stream.writable),
        env.STAGING.put('mail/' + id, stream.readable, {
          customMetadata: { from: message.from, to: message.to }
        })
      ]);
    } catch (error) {
      console.error('Staging write failed', id, error);
      throw error;
    }
  }
};
