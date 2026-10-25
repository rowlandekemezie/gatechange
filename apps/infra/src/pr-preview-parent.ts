export default {
  fetch: () =>
    new Response("Forbidden", {
      headers: { "cache-control": "private, no-store" },
      status: 403,
    }),
};
