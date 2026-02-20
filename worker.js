/**
 * CLOUDFLARE WORKER PROXY (HTMLRewriter Edition)
 * Optimized for performance, streaming, and bypassing the "PDF Freeze"
 */

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        
        // 1. URL Resolution Logic
        let targetUrl = url.searchParams.get('url');

        // Handle relative assets requested by the game/site
        if (!targetUrl) {
            const referer = request.headers.get('Referer');
            if (referer && referer.includes('url=')) {
                try {
                    const refererUrl = new URL(referer);
                    const rawTarget = refererUrl.searchParams.get('url');
                    const decodedTarget = rawTarget.includes('http') ? rawTarget : atob(rawTarget);
                    const parentTarget = new URL(decodedTarget);
                    targetUrl = new URL(url.pathname + url.search, parentTarget.origin).href;
                } catch (e) {}
            }
        }

        // Show usage instructions if no URL is provided
        if (!targetUrl) {
            return new Response('Enter a URL: /?url=https://example.com', { 
                status: 200, 
                headers: { 'Content-Type': 'text/html' } 
            });
        }

        // Auto-decode Base64 or fix missing protocol
        try { if (!targetUrl.startsWith('http')) targetUrl = atob(targetUrl); } catch (e) {}
        if (!targetUrl.startsWith('http')) targetUrl = 'https://' + targetUrl;

        const target = new URL(targetUrl);

        // 2. Prepare Request Headers (Spoofing)
        const newHeaders = new Headers(request.headers);
        newHeaders.set('Host', target.host);
        newHeaders.set('Origin', target.origin);
        newHeaders.set('Referer', target.origin + '/');
        
        // Remove Cloudflare-specific trace headers
        newHeaders.delete('cf-visitor');
        newHeaders.delete('cf-connecting-ip');
        newHeaders.delete('x-forwarded-for');

        try {
            const response = await fetch(targetUrl, {
                method: request.method,
                headers: newHeaders,
                body: request.method !== 'GET' && request.method !== 'HEAD' ? request.body : null,
                redirect: 'manual'
            });

            let newResponseHeaders = new Headers(response.headers);
            
            // 3. Cookie Fix for Logins
            const cookies = response.headers.get('Set-Cookie');
            if (cookies) {
                const fixedCookies = cookies
                    .replace(/Domain=[^;]+;?/gi, '') 
                    .replace(/Secure/gi, '')
                    .replace(/SameSite=Lax/gi, 'SameSite=None')
                    .replace(/SameSite=Strict/gi, 'SameSite=None');
                newResponseHeaders.set('Set-Cookie', fixedCookies);
            }

            // 4. Unlock Security (CORS bypass)
            newResponseHeaders.set('Access-Control-Allow-Origin', '*');
            newResponseHeaders.delete('Content-Security-Policy');
            newResponseHeaders.delete('X-Frame-Options');
            newResponseHeaders.delete('X-Content-Type-Options');

            // 5. Handle Redirects Manually
            if ([301, 302, 307, 308].includes(response.status)) {
                const location = newResponseHeaders.get('Location');
                if (location) {
                    const redirectedUrl = new URL(location, targetUrl).href;
                    newResponseHeaders.set('Location', `${url.origin}/?url=${btoa(redirectedUrl)}`);
                }
            }

            const modifiedResponse = new Response(response.body, {
                status: response.status,
                headers: newResponseHeaders
            });

            // 6. STREAMING HTML INJECTION
            // We only rewrite if the file is actually HTML.
            const contentType = newResponseHeaders.get('Content-Type') || '';
            if (contentType.includes('text/html')) {
                const injection = `
                <base href="${target.origin}/">
                <script>
                    // Prevent the target site's JS from realizing it's being proxied
                    const originalLocation = "${target.origin}";
                    Object.defineProperty(window, 'location', {
                        get: () => ({ ...window.location, origin: originalLocation, host: "${target.host}" })
                    });
                </script>`;

                // HTMLRewriter streams the document and injects our script at the <head>
                return new HTMLRewriter()
                    .on('head', {
                        element(element) {
                            element.prepend(injection, { html: true });
                        }
                    })
                    .transform(modifiedResponse);
            }

            // 7. Binary/Asset Passthrough (No HTMLRewriter applied)
            return modifiedResponse;

        } catch (e) {
            return new Response('Worker Proxy Error: ' + e.message, { status: 500 });
        }
    }
};
