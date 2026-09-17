// Netlify Edge Function: rewrites <title> and Open Graph meta tags based on
// the ?event=slug in the URL, so each event's LIFF link shows its own real
// name/date/location in LINE's link preview card — instead of one fixed
// generic title shared by every event.
//
// This runs at Netlify's edge, BEFORE the page reaches the browser (or a
// link-preview crawler like LINE's), so it can inject the correct info into
// the raw HTML itself — something client-side JavaScript can't do, since
// crawlers don't execute JS.

const SUPABASE_URL = "https://ixzvbyxhzttvnheivsoc.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml4enZieXhoenR0dm5oZWl2c29jIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODkyMTUxNzEsImV4cCI6MjEwNDc5MTE3MX0.IbPkpX8fepK4o3yDXHOGH0UXt1n3-17YXdcv36LxJuU";

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export default async (request, context) => {
  const response = await context.next();

  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("text/html")) return response;

  const url = new URL(request.url);
  const slug = url.searchParams.get("event");

  let title = "活動報名 Event Registration";
  let description = "請點此完成報名";

  if (slug) {
    try {
      const apiUrl =
        `${SUPABASE_URL}/rest/v1/events?select=name,event_date,location,description` +
        `&slug=eq.${encodeURIComponent(slug)}&is_active=eq.true`;

      const res = await fetch(apiUrl, {
        headers: {
          apikey: SUPABASE_ANON_KEY,
          Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        },
      });

      if (res.ok) {
        const rows = await res.json();
        const ev = rows && rows[0];
        if (ev) {
          title = ev.name || title;
          const metaLine = [ev.event_date, ev.location].filter(Boolean).join(" ");
          description = ev.description || metaLine || description;
        }
      }
    } catch (err) {
      // On any failure, silently fall back to the generic defaults above —
      // never break the actual page load over a preview-card cosmetic issue.
    }
  }

  let html = await response.text();
  html = html
    .replace(/<title>.*?<\/title>/s, `<title>${escapeHtml(title)}</title>`)
    .replace(/(<meta property="og:title" content=")[^"]*(")/, `$1${escapeHtml(title)}$2`)
    .replace(/(<meta property="og:description" content=")[^"]*(")/, `$1${escapeHtml(description)}$2`);

  const headers = new Headers(response.headers);
  headers.delete("content-length"); // length changed after our string replacement

  return new Response(html, { status: response.status, headers });
};

// Inline route declaration — more reliably picked up than netlify.toml alone
// for manual (non-build) drag-and-drop deploys.
export const config = { path: "/*" };
