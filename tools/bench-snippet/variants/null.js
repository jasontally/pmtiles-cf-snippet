export default { async fetch() { return new Response(new Uint8Array(200), { status: 206 }); } };
