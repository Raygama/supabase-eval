import "jsr:@supabase/functions-js/edge-runtime.d.ts";

Deno.serve(async (_req: Request) => {
  const data = {
    message: "supabase-eval is alive!",
    phase: "Phase 1 complete",
    database: {
      tables: ["users", "products", "orders", "order_items", "documents", "eval_results"],
      extensions: ["pgvector (vector 0.8.0)"]
    },
    timestamp: new Date().toISOString()
  };

  return new Response(JSON.stringify(data, null, 2), {
    headers: { "Content-Type": "application/json" }
  });
});
