import { supabase } from '../src/lib/supabase';

/**
 * Seed the `order_items` table (starts empty). Order and product IDs are
 * fetched live so this stays correct regardless of the seeded UUIDs.
 * Idempotent: clears existing rows first so re-running doesn't duplicate.
 */
async function seed() {
  const { data: orders, error: ordersErr } = await supabase
    .from('orders')
    .select('id, total_amount');
  const { data: products, error: productsErr } = await supabase
    .from('products')
    .select('id, price');

  if (ordersErr) throw ordersErr;
  if (productsErr) throw productsErr;
  if (!orders?.length || !products?.length) {
    throw new Error('Could not fetch orders/products (or they are empty)');
  }

  // Clear so the script is idempotent.
  const { error: delErr } = await supabase
    .from('order_items')
    .delete()
    .not('id', 'is', null);
  if (delErr) throw delErr;

  // Give each order 1-2 line items, deterministically.
  const items = orders.flatMap((order, i) => {
    const rows = [] as Array<{
      order_id: string;
      product_id: string;
      quantity: number;
      unit_price: number;
    }>;
    const lineCount = (i % 2) + 1;
    for (let j = 0; j < lineCount; j++) {
      const product = products[(i + j) % products.length];
      rows.push({
        order_id: order.id as string,
        product_id: product.id as string,
        quantity: ((i + j) % 3) + 1,
        unit_price: product.price as number,
      });
    }
    return rows;
  });

  const { error } = await supabase.from('order_items').insert(items);
  if (error) throw error;
  console.log(`✅ Seeded ${items.length} order_items across ${orders.length} orders`);
}

seed().catch((err) => {
  console.error('❌ Seed failed:', err);
  process.exit(1);
});
