import 'dotenv/config';
import { pool } from '../src/db.js';
import { hashPassword } from '../src/auth.js';

const restaurants = [
  {
    name: 'DirectQR Demo Café', slug: 'directqr-demo', loginId: 'DQRDEMO2026', billPrefix: 'DQR', themeColor: '#14B8A6', address: 'Demo outlet, Bareilly', phone: '9999999999',
    username: 'directqr-demo', password: 'DirectQR@2026!', voidPassword: 'Void@2026!', owner: 'Coffea Owner',
    tables: 4,
    categories: [
      { name: 'Coffee', foodType: 'VEG', items: [
        { name: 'Cappuccino', price: 180, gstRate: 5, addons: [{ name: 'Extras', options: [{ name: 'Extra Shot', price: 40 }, { name: 'Oat Milk', price: 45 }] }] },
        { name: 'Cold Coffee', price: 220, gstRate: 5, addons: [{ name: 'Extras', options: [{ name: 'Vanilla Scoop', price: 55 }, { name: 'Extra Shot', price: 40 }] }] },
        { name: 'Americano', price: 140, gstRate: 5, addons: [] },
      ]},
      { name: 'Food', foodType: 'VEG', items: [
        { name: 'Veg Club Sandwich', price: 240, gstRate: 5, addons: [{ name: 'Add-ons', options: [{ name: 'Extra Cheese', price: 35 }] }] },
        { name: 'White Sauce Pasta', price: 280, gstRate: 5, addons: [{ name: 'Add-ons', options: [{ name: 'Extra Cheese', price: 35 }, { name: 'Garlic Bread', price: 60 }] }] },
        { name: 'Loaded Fries', price: 190, gstRate: 5, addons: [] },
      ]},
      { name: 'Desserts', foodType: 'VEG', items: [
        { name: 'Chocolate Brownie', price: 150, gstRate: 5, addons: [{ name: 'Add-ons', options: [{ name: 'Vanilla Scoop', price: 55 }] }] },
      ]},
    ],
  },
  {
    name: 'DirectQR Test Bistro', slug: 'directqr-test', loginId: 'DQRBISTRO2026', billPrefix: 'DQB', themeColor: '#14B8A6', address: 'Demo outlet, Bareilly', phone: '9999999998',
    username: 'directqr-bistro', password: 'DirectQR@2026!', voidPassword: 'Void@2026!', owner: 'Bistro Owner',
    tables: 4,
    categories: [
      { name: 'Starters', foodType: 'VEG', items: [{ name: 'Crispy Corn', price: 220, gstRate: 5, addons: [] }] },
      { name: 'Mains', foodType: 'NON_VEG', items: [{ name: 'Paneer Tikka Wrap', price: 260, gstRate: 5, addons: [] }, { name: 'Chicken Burger', price: 290, gstRate: 5, addons: [] }] },
      { name: 'Beverages', foodType: 'VEG', items: [{ name: 'Fresh Lime Soda', price: 110, gstRate: 5, addons: [] }] },
    ],
  },
];

for (const data of restaurants) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const passwordHash = await hashPassword(data.password);
    const voidPasswordHash = await hashPassword(data.voidPassword);
    const restaurantResult = await client.query(
      `INSERT INTO restaurants (name, slug, login_id, bill_prefix, theme_color, address, phone, void_password_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, login_id = EXCLUDED.login_id, bill_prefix = EXCLUDED.bill_prefix, theme_color = EXCLUDED.theme_color, address = EXCLUDED.address, phone = EXCLUDED.phone, void_password_hash = EXCLUDED.void_password_hash
       RETURNING id`,
      [data.name, data.slug, data.loginId, data.billPrefix, data.themeColor, data.address, data.phone, voidPasswordHash],
    );
    const restaurantId = restaurantResult.rows[0].id;
    await client.query(
      `INSERT INTO users (restaurant_id, username, password_hash, display_name, role)
       VALUES ($1,$2,$3,$4,'OWNER')
       ON CONFLICT (restaurant_id, username) DO UPDATE SET password_hash = EXCLUDED.password_hash, display_name = EXCLUDED.display_name, role = 'OWNER', is_active = true`,
      [restaurantId, data.username, passwordHash, data.owner],
    );
    // Fresh DirectQR demos are active and paid for one year so table QR flows
    // can be tested immediately. This seed is never used when client data exists.
    await client.query(`UPDATE restaurants SET operational_status = 'ACTIVE' WHERE id = $1`, [restaurantId]);
    await client.query(
      `INSERT INTO restaurant_commercials
        (restaurant_id, base_package_name, base_license_amount, base_payment_status, base_license_start_date, base_license_end_date,
         support_amount, support_payment_status, support_start_date, support_last_payment_date, support_next_payment_due)
       VALUES ($1,'DirectQR Annual Licence',3000,'PAID',CURRENT_DATE,(CURRENT_DATE + INTERVAL '1 year')::date,
               299,'PAID',CURRENT_DATE,CURRENT_DATE,(CURRENT_DATE + INTERVAL '1 month')::date)
       ON CONFLICT (restaurant_id) DO UPDATE SET
         base_package_name = EXCLUDED.base_package_name, base_license_amount = EXCLUDED.base_license_amount,
         base_payment_status = EXCLUDED.base_payment_status, base_license_start_date = EXCLUDED.base_license_start_date,
         base_license_end_date = EXCLUDED.base_license_end_date, support_amount = EXCLUDED.support_amount,
         support_payment_status = EXCLUDED.support_payment_status, support_start_date = EXCLUDED.support_start_date,
         support_last_payment_date = EXCLUDED.support_last_payment_date, support_next_payment_due = EXCLUDED.support_next_payment_due`,
      [restaurantId],
    );
    await client.query(
      `INSERT INTO restaurant_setup_tasks (restaurant_id, task_key, is_completed, completed_at)
       SELECT $1, task_key, TRUE, now()
       FROM (VALUES ('BASICS'), ('OWNER_ACCOUNT'), ('OWNER_PASSWORD_CHANGED'), ('MENU'), ('TABLES'),
                    ('GST_BILLING'), ('PRINTER_TEST'), ('QR_SETUP'), ('STAFF_TRAINING'), ('GO_LIVE')) AS tasks(task_key)
       ON CONFLICT (restaurant_id, task_key) DO UPDATE SET is_completed = TRUE, completed_at = now()`,
      [restaurantId],
    );
    for (let i = 1; i <= data.tables; i += 1) {
      await client.query(
        `INSERT INTO dining_tables (restaurant_id, name, position)
         VALUES ($1,$2,$3) ON CONFLICT (restaurant_id, name) DO NOTHING`,
        [restaurantId, `T${i}`, i],
      );
    }
    for (let c = 0; c < data.categories.length; c += 1) {
      const categoryData = data.categories[c];
      const categoryResult = await client.query(
        `INSERT INTO categories (restaurant_id, name, position, food_type)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (restaurant_id, name) DO UPDATE SET position = EXCLUDED.position, food_type = EXCLUDED.food_type
         RETURNING id`,
        [restaurantId, categoryData.name, c, categoryData.foodType || 'VEG'],
      );
      const categoryId = categoryResult.rows[0].id;
      for (const itemData of categoryData.items) {
        const existing = await client.query(
          'SELECT id FROM menu_items WHERE restaurant_id = $1 AND name = $2 LIMIT 1',
          [restaurantId, itemData.name],
        );
        let itemId = existing.rows[0]?.id;
        if (itemId) {
          await client.query(
            `UPDATE menu_items
             SET category_id = $2, price = $3, gst_rate = $4, gst_inclusive = false, is_active = true, updated_at = now()
             WHERE id = $1`,
            [itemId, categoryId, itemData.price, itemData.gstRate],
          );
        } else {
          const itemResult = await client.query(
            `INSERT INTO menu_items (restaurant_id, category_id, name, price, gst_rate, gst_inclusive)
             VALUES ($1,$2,$3,$4,$5,false)
             RETURNING id`,
            [restaurantId, categoryId, itemData.name, itemData.price, itemData.gstRate],
          );
          itemId = itemResult.rows[0].id;
        }
        // Reseeding must not duplicate add-ons in a local demo database.
        await client.query('DELETE FROM addon_groups WHERE menu_item_id = $1', [itemId]);
        for (let g = 0; g < itemData.addons.length; g += 1) {
          const groupData = itemData.addons[g];
          const group = await client.query(
            `INSERT INTO addon_groups (menu_item_id, name, min_select, max_select, position)
             VALUES ($1,$2,0,3,$3) RETURNING id`, [itemId, groupData.name, g],
          );
          for (let o = 0; o < groupData.options.length; o += 1) {
            const option = groupData.options[o];
            await client.query(
              'INSERT INTO addon_options (addon_group_id, name, price, position) VALUES ($1,$2,$3,$4)',
              [group.rows[0].id, option.name, option.price, o],
            );
          }
        }
      }
    }
    await client.query('COMMIT');
    console.log(`Seeded ${data.name} (${data.username})`);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
await pool.end();
