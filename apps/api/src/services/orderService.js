import { withTransaction } from "../db.js";
import { calculateCart, moneyToNumber, moneyToString, toPaise } from "@directqr/core/tax";
function parseSnapshot(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return [];
    }
  }
  return [];
}
function itemKey(menuItemId, addons = []) {
  const addonIds = addons.map((addon) => typeof addon === "string" ? addon : addon?.id).filter(Boolean).sort();
  return `${menuItemId || "deleted"}|${addonIds.join(",")}`;
}
function itemKeyFromRequested(item) {
  return itemKey(item.menuItemId, item.addonOptionIds || []);
}
function itemKeyFromExisting(item) {
  return itemKey(item.menu_item_id, parseSnapshot(item.addons_snapshot));
}
function conflict(message = "This order changed on another terminal. Reload the table before continuing.") {
  return Object.assign(new Error(message), { status: 409 });
}
function validationError(message) {
  return Object.assign(new Error(message), { status: 400 });
}
function snapshotLine(existing, quantity) {
  return {
    menuItemId: existing.menu_item_id,
    itemName: existing.item_name,
    unitPrice: existing.unit_price,
    gstRate: existing.gst_rate,
    gstInclusive: existing.gst_inclusive,
    quantity,
    addonUnitTotal: existing.addon_unit_total,
    addonsSnapshot: parseSnapshot(existing.addons_snapshot)
  };
}
function kotAddons(snapshot) {
  return parseSnapshot(snapshot).map((addon) => ({ id: addon.id, name: addon.name }));
}
async function recordOrderEvent(client, { orderId, restaurantId, userId, eventType, payload = {} }) {
  await client.query(
    `INSERT INTO order_events (order_id, restaurant_id, actor_user_id, event_type, payload)
     VALUES ($1,$2,$3,$4,$5::jsonb)`,
    [orderId, restaurantId, userId, eventType, JSON.stringify(payload)]
  );
}
async function recordAudit(client, restaurantId, userId, action, entityType, entityId, metadata = {}) {
  await client.query(
    `INSERT INTO audit_logs (restaurant_id, user_id, action, entity_type, entity_id, metadata)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
    [restaurantId, userId, action, entityType, entityId, JSON.stringify(metadata)]
  );
}
export async function fetchValidatedCart(client, restaurantId, requestedItems, existingItems = []) {
  const requestedKeys = /* @__PURE__ */ new Set();
  for (const requested of requestedItems) {
    if (new Set(requested.addonOptionIds || []).size !== (requested.addonOptionIds || []).length) {
      throw validationError("The same add-on cannot be selected twice on one item.");
    }
    const key = itemKeyFromRequested(requested);
    if (requestedKeys.has(key)) throw validationError("Duplicate cart lines are not allowed. Use quantity for identical item configurations.");
    requestedKeys.add(key);
  }
  const existingByKey = new Map(existingItems.map((item) => [itemKeyFromExisting(item), item]));
  const itemIds = [...new Set(requestedItems.map((item) => item.menuItemId))];
  const { rows: menuRows } = await client.query(
    `SELECT id, name, price, gst_rate, gst_inclusive, is_active, availability
     FROM menu_items
     WHERE restaurant_id = $1 AND id = ANY($2::uuid[])`,
    [restaurantId, itemIds]
  );
  const menuById = new Map(menuRows.map((row) => [row.id, row]));
  const needsCurrentValidation = requestedItems.filter((requested) => {
    const existing = existingByKey.get(itemKeyFromRequested(requested));
    return !existing || requested.quantity > Number(existing.quantity);
  });
  for (const requested of needsCurrentValidation) {
    const menuItem = menuById.get(requested.menuItemId);
    if (!menuItem || !menuItem.is_active || menuItem.availability !== 'AVAILABLE') throw validationError("One or more menu items are unavailable.");
  }
  const validationItemIds = [...new Set(needsCurrentValidation.map((item) => item.menuItemId))];
  const selectedAddonIds = [...new Set(needsCurrentValidation.flatMap((item) => item.addonOptionIds || []))];
  const groupsByItemId = /* @__PURE__ */ new Map();
  const addonsById = /* @__PURE__ */ new Map();
  if (validationItemIds.length) {
    const { rows: groups } = await client.query(
      `SELECT id, menu_item_id, name, min_select, max_select
       FROM addon_groups
       WHERE menu_item_id = ANY($1::uuid[])
       ORDER BY position`,
      [validationItemIds]
    );
    groups.forEach((group) => {
      const list = groupsByItemId.get(group.menu_item_id) || [];
      list.push(group);
      groupsByItemId.set(group.menu_item_id, list);
    });
  }
  if (selectedAddonIds.length) {
    const { rows: addons } = await client.query(
      `SELECT ao.id, ao.name, ao.price, ag.menu_item_id, ag.id AS addon_group_id
       FROM addon_options ao
       JOIN addon_groups ag ON ag.id = ao.addon_group_id
       JOIN menu_items mi ON mi.id = ag.menu_item_id
       WHERE mi.restaurant_id = $1 AND mi.is_active = true AND ao.is_active = true
         AND ao.id = ANY($2::uuid[])`,
      [restaurantId, selectedAddonIds]
    );
    if (addons.length !== selectedAddonIds.length) throw validationError("One or more add-ons are unavailable.");
    addons.forEach((addon) => addonsById.set(addon.id, addon));
  }
  return requestedItems.map((requested) => {
    const key = itemKeyFromRequested(requested);
    const existing = existingByKey.get(key);
    const menuItem = menuById.get(requested.menuItemId);
    const validatesCurrentMenu = !existing || requested.quantity > Number(existing.quantity);
    if (existing && !validatesCurrentMenu) return snapshotLine(existing, requested.quantity);
    const selectedAddons = (requested.addonOptionIds || []).map((id) => addonsById.get(id));
    if (selectedAddons.some((addon) => !addon || addon.menu_item_id !== requested.menuItemId)) {
      throw validationError("An add-on does not belong to the selected item.");
    }
    const groupCounts = /* @__PURE__ */ new Map();
    selectedAddons.forEach((addon) => {
      groupCounts.set(addon.addon_group_id, (groupCounts.get(addon.addon_group_id) || 0) + 1);
    });
    for (const group of groupsByItemId.get(requested.menuItemId) || []) {
      const count = groupCounts.get(group.id) || 0;
      if (count < Number(group.min_select) || count > Number(group.max_select)) {
        const required = Number(group.min_select) === Number(group.max_select) ? String(group.min_select) : `${group.min_select}\u2013${group.max_select}`;
        throw validationError(`${menuItem.name}: select ${required} option(s) for ${group.name}.`);
      }
    }
    if (existing) return snapshotLine(existing, requested.quantity);
    const addonUnitTotalPaise = selectedAddons.reduce((sum, addon) => sum + toPaise(addon.price), 0);
    return {
      menuItemId: menuItem.id,
      itemName: menuItem.name,
      unitPrice: menuItem.price,
      gstRate: menuItem.gst_rate,
      // New menu rows are always exclusive. Preserve the field so old
      // snapshots can still be calculated if a local database existed before
      // the V1 exclusive-price rule.
      gstInclusive: Boolean(menuItem.gst_inclusive),
      quantity: requested.quantity,
      addonUnitTotal: moneyToString(addonUnitTotalPaise),
      addonsSnapshot: selectedAddons.map((addon) => ({ id: addon.id, name: addon.name, price: moneyToNumber(toPaise(addon.price)) })).sort((a, b) => a.id.localeCompare(b.id))
    };
  });
}
async function allocateTakeawayToken(client, restaurantId) {
  const { rows: restaurantRows } = await client.query(
    `SELECT timezone FROM restaurants WHERE id = $1 FOR SHARE`,
    [restaurantId]
  );
  const timezone = restaurantRows[0]?.timezone || 'Asia/Kolkata';
  const { rows: dateRows } = await client.query(
    `SELECT (now() AT TIME ZONE $1)::date AS business_date`,
    [timezone]
  );
  const businessDate = dateRows[0].business_date;
  const { rows } = await client.query(
    `INSERT INTO restaurant_takeaway_days (restaurant_id, business_date, next_takeaway_number)
     VALUES ($1,$2,2)
     ON CONFLICT (restaurant_id, business_date)
     DO UPDATE SET next_takeaway_number = restaurant_takeaway_days.next_takeaway_number + 1
     RETURNING next_takeaway_number - 1 AS takeaway_token`,
    [restaurantId, businessDate]
  );
  return { businessDate, takeawayToken: Number(rows[0].takeaway_token) };
}

async function createOpenOrder(client, { restaurantId, userId, tableId, orderType = 'DINE_IN' }) {
  if (orderType === 'TAKEAWAY') {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`forgearc-takeaway:${restaurantId}`]);
    const { businessDate, takeawayToken } = await allocateTakeawayToken(client, restaurantId);
    const nextNumber = await client.query(
      `UPDATE restaurants
       SET next_order_number = next_order_number + 1, updated_at = now()
       WHERE id = $1
       RETURNING next_order_number - 1 AS order_number`,
      [restaurantId]
    );
    const inserted = await client.query(
      `INSERT INTO orders
        (restaurant_id, order_number, order_type, takeaway_token, takeaway_business_date, created_by)
       VALUES ($1,$2,'TAKEAWAY',$3,$4,$5)
       RETURNING id, revision, order_type, takeaway_token, takeaway_business_date`,
      [restaurantId, nextNumber.rows[0].order_number, takeawayToken, businessDate, userId]
    );
    await recordOrderEvent(client, {
      orderId: inserted.rows[0].id,
      restaurantId,
      userId,
      eventType: 'ORDER_OPENED',
      payload: { orderType: 'TAKEAWAY', takeawayToken, businessDate },
    });
    return inserted.rows[0];
  }

  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`forgearc-open-table:${tableId}`]);
  const tableCheck = await client.query(
    `SELECT id FROM dining_tables WHERE id = $1 AND restaurant_id = $2 AND is_active = true`,
    [tableId, restaurantId]
  );
  if (!tableCheck.rows[0]) throw Object.assign(new Error('Table not found.'), { status: 404 });

  const existing = await client.query(
    `SELECT id FROM orders WHERE table_id = $1 AND restaurant_id = $2 AND status = 'OPEN' FOR UPDATE`,
    [tableId, restaurantId]
  );
  if (existing.rows[0]) throw conflict('This table already has an open order. Reload Table View before continuing.');

  const nextNumber = await client.query(
    `UPDATE restaurants
     SET next_order_number = next_order_number + 1, updated_at = now()
     WHERE id = $1
     RETURNING next_order_number - 1 AS order_number`,
    [restaurantId]
  );
  const inserted = await client.query(
    `INSERT INTO orders (restaurant_id, table_id, order_number, order_type, created_by)
     VALUES ($1,$2,$3,'DINE_IN',$4) RETURNING id, revision, order_type`,
    [restaurantId, tableId, nextNumber.rows[0].order_number, userId]
  );
  await recordOrderEvent(client, {
    orderId: inserted.rows[0].id,
    restaurantId,
    userId,
    eventType: 'ORDER_OPENED',
    payload: { tableId, orderType: 'DINE_IN' },
  });
  return inserted.rows[0];
}

function assertRevision(order, expectedRevision) {
  if (!Number.isInteger(Number(expectedRevision)) || Number(expectedRevision) !== Number(order.revision)) throw conflict();
}
async function upsertDraftOrder(client, { restaurantId, userId, orderId, draft, expectedRevision, lineSource = 'QR_CUSTOMER' }) {
  let order;
  if (orderId) {
    const existing = await client.query(
      `SELECT * FROM orders WHERE id = $1 AND restaurant_id = $2 AND status = 'OPEN' FOR UPDATE`,
      [orderId, restaurantId]
    );
    order = existing.rows[0];
    if (!order) throw Object.assign(new Error("Open order not found."), { status: 404 });
    assertRevision(order, expectedRevision);
    if (order.bill_locked_at) throw validationError('This bill was printed and is awaiting payment. Settle it or void the order before making changes.');
    if ((order.order_type || 'DINE_IN') !== draft.orderType) throw validationError('Order type cannot be changed after an order is created.');
  } else {
    if (draft.orderType === 'TAKEAWAY') {
      if (draft.tableId) throw validationError('Takeaway orders cannot be assigned to a table.');
      order = await createOpenOrder(client, { restaurantId, userId, orderType: 'TAKEAWAY' });
    } else {
      if (!draft.tableId) throw validationError('A table is required for a new dine-in order.');
      order = await createOpenOrder(client, { restaurantId, userId, tableId: draft.tableId, orderType: 'DINE_IN' });
    }
  }
  const { rows: existingItems } = await client.query(
    "SELECT * FROM order_items WHERE order_id = $1 FOR UPDATE",
    [order.id]
  );
  const validatedCart = await fetchValidatedCart(client, restaurantId, draft.items, existingItems);
  const { rows: restaurantRows } = await client.query(
    'SELECT container_charge_gst_rate FROM restaurants WHERE id = $1 FOR SHARE',
    [restaurantId]
  );
  const containerGstRate = Number(restaurantRows[0]?.container_charge_gst_rate || 0);
  const calculated = calculateCart(validatedCart, draft.discountType, draft.discountValue, {
    containerCharge: draft.containerCharge,
    containerGstRate,
  });
  const existingByKey = new Map(existingItems.map((item) => [itemKeyFromExisting(item), item]));
  const requestedByKey = new Map(calculated.lines.map((item) => [itemKey(item.menuItemId, item.addonsSnapshot), item]));
  for (const existing of existingItems) {
    const next = requestedByKey.get(itemKeyFromExisting(existing));
    if (!next && Number(existing.sent_to_kitchen_qty) > 0) {
      throw validationError(`Cannot remove ${existing.item_name} after it was sent to the kitchen.`);
    }
    if (next && Number(next.quantity) < Number(existing.sent_to_kitchen_qty)) {
      throw validationError(`Cannot reduce ${existing.item_name} below its KOT-sent quantity.`);
    }
  }
  for (const line of calculated.lines) {
    const key = itemKey(line.menuItemId, line.addonsSnapshot);
    const existing = existingByKey.get(key);
    const values = [
      moneyToString(line.taxableBeforeDiscountPaise),
      moneyToString(line.discountPaise),
      moneyToString(line.cgstPaise),
      moneyToString(line.sgstPaise),
      moneyToString(line.gstPaise),
      moneyToString(line.lineTotalPaise)
    ];
    if (existing) {
      await client.query(
        `UPDATE order_items
         SET quantity = $2, line_taxable_before_discount = $3, line_discount = $4,
             line_cgst = $5, line_sgst = $6, line_gst = $7, line_total = $8, updated_at = now()
         WHERE id = $1`,
        [existing.id, line.quantity, ...values]
      );
    } else {
      await client.query(
        `INSERT INTO order_items
          (order_id, menu_item_id, item_name, unit_price, gst_rate, gst_inclusive, quantity, addons_snapshot, addon_unit_total,
           line_taxable_before_discount, line_discount, line_cgst, line_sgst, line_gst, line_total, line_source, added_by_user_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
        [
          order.id,
          line.menuItemId,
          line.itemName,
          moneyToString(toPaise(line.unitPrice)),
          line.gstRate,
          line.gstInclusive,
          line.quantity,
          JSON.stringify(line.addonsSnapshot),
          moneyToString(toPaise(line.addonUnitTotal)),
          ...values,
          lineSource,
          lineSource === 'STAFF' ? userId : null,
        ]
      );
    }
  }
  for (const existing of existingItems) {
    if (!requestedByKey.has(itemKeyFromExisting(existing)) && Number(existing.sent_to_kitchen_qty) === 0) {
      await client.query("DELETE FROM order_items WHERE id = $1", [existing.id]);
    }
  }
  const customerNameProvided = typeof draft.customerName !== 'undefined';
  const customerMobileProvided = typeof draft.customerMobile !== 'undefined';
  const updated = await client.query(
    `UPDATE orders
     SET subtotal = $2, taxable_amount = $3, discount_type = $4, discount_value = $5, discount_amount = $6,
         cgst_amount = $7, sgst_amount = $8, gst_amount = $9, round_off = $10, grand_total = $11,
         notes = $12, container_charge = $13, container_gst_rate = $14, container_taxable_amount = $15,
         container_cgst_amount = $16, container_sgst_amount = $17, container_gst_amount = $18,
         customer_name = CASE WHEN $19::boolean THEN NULLIF($20, '') ELSE customer_name END,
         customer_mobile = CASE WHEN $21::boolean THEN NULLIF($22, '') ELSE customer_mobile END,
         revision = revision + 1, updated_at = now()
     WHERE id = $1
     RETURNING id, revision`,
    [
      order.id,
      moneyToString(calculated.totals.subtotalPaise),
      moneyToString(calculated.totals.taxableAmountPaise),
      draft.discountType || null,
      draft.discountType === 'FIXED' ? moneyToString(toPaise(draft.discountValue || 0)) : Number(draft.discountValue || 0),
      moneyToString(calculated.totals.discountAmountPaise),
      moneyToString(calculated.totals.cgstAmountPaise),
      moneyToString(calculated.totals.sgstAmountPaise),
      moneyToString(calculated.totals.gstAmountPaise),
      moneyToString(calculated.totals.roundOffPaise),
      moneyToString(calculated.totals.grandTotalPaise),
      draft.notes || null,
      moneyToString(calculated.totals.containerChargePaise),
      calculated.totals.containerGstRate,
      moneyToString(calculated.totals.containerTaxableAmountPaise),
      moneyToString(calculated.totals.containerCgstPaise),
      moneyToString(calculated.totals.containerSgstPaise),
      moneyToString(calculated.totals.containerGstPaise),
      customerNameProvided,
      draft.customerName ?? '',
      customerMobileProvided,
      draft.customerMobile ?? '',
    ]
  );
  await recordOrderEvent(client, {
    orderId: order.id,
    restaurantId,
    userId,
    eventType: "ORDER_UPDATED",
    payload: {
      itemLines: calculated.lines.length,
      subtotal: calculated.totals.subtotal,
      containerCharge: calculated.totals.containerCharge,
      containerGst: calculated.totals.containerGstAmount,
      gst: calculated.totals.gstAmount,
      roundOff: calculated.totals.roundOff,
      grandTotal: calculated.totals.grandTotal,
      customerDetailsSaved: customerNameProvided || customerMobileProvided
    }
  });
  return { orderId: order.id, revision: Number(updated.rows[0].revision), orderType: order.order_type || draft.orderType || 'DINE_IN', takeawayToken: order.takeaway_token == null ? null : Number(order.takeaway_token), totals: calculated.totals };
}
async function saveDraft({ restaurantId, userId, orderId, draft, expectedRevision, lineSource = 'QR_CUSTOMER' }) {
  return withTransaction((client) => upsertDraftOrder(client, {
    restaurantId,
    userId,
    orderId,
    draft,
    expectedRevision,
    lineSource,
  }));
}

export async function prepareQrCart(client, { restaurantId, items }) {
  const validatedCart = await fetchValidatedCart(client, restaurantId, items, []);
  const { rows: restaurantRows } = await client.query(
    'SELECT container_charge_gst_rate FROM restaurants WHERE id = $1 FOR SHARE',
    [restaurantId]
  );
  const calculated = calculateCart(validatedCart, null, 0, {
    containerCharge: 0,
    containerGstRate: Number(restaurantRows[0]?.container_charge_gst_rate || 0),
  });
  return { validatedCart, calculated };
}

export async function acceptQrOrder({ restaurantId, userId, qrOrderId }) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT q.*, c.display_name AS customer_name, c.phone AS customer_phone
       FROM qr_orders q
       JOIN customer_accounts c ON c.id = q.customer_id
       WHERE q.id = $1 AND q.restaurant_id = $2
       FOR UPDATE`,
      [qrOrderId, restaurantId]
    );
    const qrOrder = rows[0];
    if (!qrOrder) throw Object.assign(new Error('QR order not found.'), { status: 404 });
    if (qrOrder.status !== 'PENDING') throw Object.assign(new Error('This QR order has already been processed.'), { status: 409 });

    // QR requests can arrive while staff already has a running table bill. Lock the
    // table first so acceptance is deterministic, then merge the request into that
    // one open order instead of creating a competing order for the same table.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`forgearc-open-table:${qrOrder.table_id}`]);
    const existingResult = await client.query(
      `SELECT * FROM orders
       WHERE table_id = $1 AND restaurant_id = $2 AND status = 'OPEN'
       FOR UPDATE`,
      [qrOrder.table_id, restaurantId]
    );
    const existingOrder = existingResult.rows[0] || null;
    if (existingOrder?.bill_locked_at) {
      throw validationError('This table bill is already printed and awaiting payment. Settle it before accepting another QR order.');
    }

    let combinedItems = parseSnapshot(qrOrder.requested_items);
    if (existingOrder) {
      const { rows: existingItems } = await client.query(
        `SELECT menu_item_id, quantity, addons_snapshot
         FROM order_items
         WHERE order_id = $1
         ORDER BY created_at
         FOR UPDATE`,
        [existingOrder.id]
      );
      const merged = new Map();
      for (const item of existingItems) {
        if (!item.menu_item_id) continue;
        const itemInput = {
          menuItemId: item.menu_item_id,
          quantity: Number(item.quantity),
          addonOptionIds: parseSnapshot(item.addons_snapshot).map((addon) => addon?.id).filter(Boolean).sort(),
        };
        merged.set(itemKeyFromRequested(itemInput), itemInput);
      }
      for (const item of parseSnapshot(qrOrder.requested_items)) {
        const itemInput = {
          menuItemId: item.menuItemId,
          quantity: Number(item.quantity),
          addonOptionIds: Array.isArray(item.addonOptionIds) ? [...item.addonOptionIds].sort() : [],
        };
        const key = itemKeyFromRequested(itemInput);
        const current = merged.get(key);
        if (current) current.quantity += itemInput.quantity;
        else merged.set(key, itemInput);
      }
      combinedItems = [...merged.values()];
    }

    const requestDetail = [
      `QR request from ${qrOrder.customer_name}${qrOrder.customer_phone ? ` (${qrOrder.customer_phone})` : ''}`,
      qrOrder.guest_count ? `${qrOrder.guest_count} guest${Number(qrOrder.guest_count) === 1 ? '' : 's'}` : '',
      qrOrder.notes || '',
    ].filter(Boolean).join(' · ');
    const combinedNotes = [existingOrder?.notes, requestDetail].filter(Boolean).join(' | ').slice(0, 500) || null;

    const customerFields = {};
    if (!existingOrder?.customer_name && qrOrder.customer_name) customerFields.customerName = qrOrder.customer_name;
    if (!existingOrder?.customer_mobile && qrOrder.customer_phone) customerFields.customerMobile = qrOrder.customer_phone;

    const result = await upsertDraftOrder(client, {
      restaurantId,
      userId,
      orderId: existingOrder?.id || null,
      expectedRevision: existingOrder ? Number(existingOrder.revision) : null,
      draft: {
        orderType: 'DINE_IN',
        tableId: qrOrder.table_id,
        items: combinedItems,
        discountType: existingOrder?.discount_type || null,
        discountValue: existingOrder?.discount_value || 0,
        containerCharge: Number(existingOrder?.container_charge || 0),
        notes: combinedNotes,
        ...customerFields,
      },
    });
    await client.query(
      `UPDATE qr_orders
       SET status = 'ACCEPTED', accepted_order_id = $2, processed_by = $3, processed_at = now(), updated_at = now()
       WHERE id = $1`,
      [qrOrderId, result.orderId, userId]
    );
    await recordAudit(client, restaurantId, userId, 'QR_ORDER_ACCEPTED', 'QR_ORDER', qrOrderId, {
      orderId: result.orderId,
      tableId: qrOrder.table_id,
      mergedIntoExistingOrder: Boolean(existingOrder),
    });
    return { ...result, qrOrderId, tableId: qrOrder.table_id, mergedIntoExistingOrder: Boolean(existingOrder) };
  });
}

async function allocateDailyKotNumber(client, restaurantId) {
  const { rows: restaurantRows } = await client.query(
    `SELECT timezone FROM restaurants WHERE id = $1 FOR SHARE`,
    [restaurantId]
  );
  const timezone = restaurantRows[0]?.timezone || "Asia/Kolkata";
  const { rows: dateRows } = await client.query(
    `SELECT (now() AT TIME ZONE $1)::date AS business_date`,
    [timezone]
  );
  const businessDate = dateRows[0].business_date;
  const { rows } = await client.query(
    `INSERT INTO restaurant_kot_days (restaurant_id, business_date, next_kot_number)
     VALUES ($1,$2,2)
     ON CONFLICT (restaurant_id, business_date)
     DO UPDATE SET next_kot_number = restaurant_kot_days.next_kot_number + 1
     RETURNING next_kot_number - 1 AS daily_kot_number`,
    [restaurantId, businessDate]
  );
  return { businessDate, dailyKotNumber: Number(rows[0].daily_kot_number) };
}
async function printKot({ restaurantId, userId, orderId, expectedRevision }) {
  return withTransaction(async (client) => {
    const { rows: orderRows } = await client.query(
      `SELECT * FROM orders
       WHERE id = $1 AND restaurant_id = $2 AND status = 'OPEN'
       FOR UPDATE`,
      [orderId, restaurantId]
    );
    const order = orderRows[0];
    if (!order) throw Object.assign(new Error("Open order not found."), { status: 404 });
    assertRevision(order, expectedRevision);
    if (order.bill_locked_at) throw validationError("This bill has already been printed and is awaiting payment. KOT changes are locked.");
    const { rows: newItems } = await client.query(
      `SELECT id, item_name, quantity, sent_to_kitchen_qty, addons_snapshot
       FROM order_items
       WHERE order_id = $1 AND quantity > sent_to_kitchen_qty
       ORDER BY created_at`,
      [order.id]
    );
    if (!newItems.length) throw validationError("No new items are waiting for the KOT. Use Reprint Last KOT if the kitchen needs another copy.");
    const sequence = Number(order.kot_sequence) + 1;
    const { businessDate, dailyKotNumber } = await allocateDailyKotNumber(client, restaurantId);
    const items = newItems.map((item) => ({
      // lineId stays server-side in the KOT payload for accurate KOT View status matching. Print layouts deliberately ignore it.
      lineId: item.id,
      itemName: item.item_name,
      quantity: Number(item.quantity) - Number(item.sent_to_kitchen_qty),
      // KOT payload deliberately excludes price data.
      addons: kotAddons(item.addons_snapshot)
    }));
    await client.query(
      `INSERT INTO kot_prints (order_id, restaurant_id, business_date, daily_kot_number, sequence, items, printed_by)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)`,
      [order.id, restaurantId, businessDate, dailyKotNumber, sequence, JSON.stringify(items), userId]
    );
    await client.query(
      "UPDATE order_items SET sent_to_kitchen_qty = quantity, updated_at = now() WHERE id = ANY($1::uuid[])",
      [newItems.map((item) => item.id)]
    );
    await client.query(
      "UPDATE orders SET kot_sequence = $2, revision = revision + 1, updated_at = now() WHERE id = $1",
      [order.id, sequence]
    );
    await recordOrderEvent(client, {
      orderId: order.id,
      restaurantId,
      userId,
      eventType: "KOT_SENT",
      payload: { sequence, dailyKotNumber, items }
    });
    const fullOrder = await getOrder(client, restaurantId, order.id);
    return {
      order: fullOrder,
      kot: { sequence, dailyKotNumber, businessDate, items, printedAt: (/* @__PURE__ */ new Date()).toISOString(), isReprint: false }
    };
  });
}
async function printDraftBill({ restaurantId, userId, orderId, expectedRevision, customerName, customerMobile }) {
  return withTransaction(async (client) => {
    const { rows: orderRows } = await client.query(
      `SELECT * FROM orders WHERE id = $1 AND restaurant_id = $2 AND status = 'OPEN' FOR UPDATE`,
      [orderId, restaurantId]
    );
    const order = orderRows[0];
    if (!order) throw Object.assign(new Error("Open order not found."), { status: 404 });
    assertRevision(order, expectedRevision);
    if (order.bill_locked_at) throw validationError("A bill was already printed for this order. Settle it using the payment shortcut.");
    const { rows: itemCount } = await client.query("SELECT COUNT(*)::int AS count FROM order_items WHERE order_id = $1", [order.id]);
    if (!itemCount[0].count) throw validationError("Add at least one item before printing a bill.");
    const { rows: restaurantRows } = await client.query(
      `SELECT name, address, phone, gstin, bill_prefix
       FROM restaurants WHERE id = $1 FOR SHARE`,
      [restaurantId]
    );
    const restaurant = restaurantRows[0];
    if (!restaurant) throw Object.assign(new Error("Restaurant not found."), { status: 404 });
    const customerNameProvided = typeof customerName !== "undefined";
    const customerMobileProvided = typeof customerMobile !== "undefined";
    await client.query(
      `UPDATE orders
       SET bill_print_requested_at = now(), bill_locked_at = now(),
           restaurant_name_snapshot = $2, restaurant_address_snapshot = $3, restaurant_phone_snapshot = $4,
           restaurant_gstin_snapshot = $5, bill_prefix_snapshot = $6,
           customer_name = CASE WHEN $7::boolean THEN NULLIF($8, '') ELSE customer_name END,
           customer_mobile = CASE WHEN $9::boolean THEN NULLIF($10, '') ELSE customer_mobile END,
           revision = revision + 1, updated_at = now()
       WHERE id = $1`,
      [
        order.id, restaurant.name, restaurant.address, restaurant.phone, restaurant.gstin, restaurant.bill_prefix,
        customerNameProvided, customerName ?? '', customerMobileProvided, customerMobile ?? ''
      ]
    );
    await recordOrderEvent(client, {
      orderId: order.id,
      restaurantId,
      userId,
      eventType: "BILL_PRINT_REQUESTED",
      payload: {
        source: "browser-print",
        paymentPending: true,
        customerDetailsSaved: customerNameProvided || customerMobileProvided
      }
    });
    await recordAudit(client, restaurantId, userId, "BILL_PRINTED_PENDING_PAYMENT", "ORDER", order.id, {
      customerDetailsSaved: customerNameProvided || customerMobileProvided
    });
    return getOrder(client, restaurantId, order.id);
  });
}
async function reprintLatestKot({ restaurantId, userId, orderId }) {
  return withTransaction(async (client) => {
    const { rows: orderRows } = await client.query(
      `SELECT id FROM orders WHERE id = $1 AND restaurant_id = $2 FOR SHARE`,
      [orderId, restaurantId]
    );
    if (!orderRows[0]) throw Object.assign(new Error("Order not found."), { status: 404 });
    const { rows: kotRows } = await client.query(
      `SELECT sequence, daily_kot_number, business_date, items, printed_at
       FROM kot_prints
       WHERE order_id = $1
       ORDER BY sequence DESC
       LIMIT 1`,
      [orderId]
    );
    const kot = kotRows[0];
    if (!kot) throw validationError("This order has no KOT to reprint.");
    await recordAudit(client, restaurantId, userId, "KOT_REPRINT_REQUESTED", "ORDER", orderId, { sequence: Number(kot.sequence) });
    const order = await getOrder(client, restaurantId, orderId);
    return {
      order,
      kot: {
        sequence: Number(kot.sequence),
        dailyKotNumber: Number(kot.daily_kot_number || kot.sequence),
        businessDate: kot.business_date,
        items: parseSnapshot(kot.items),
        printedAt: kot.printed_at,
        isReprint: true
      }
    };
  });
}
async function settleOrder({ restaurantId, userId, orderId, expectedRevision, payments, printBill, customerName = "", customerMobile = "" }) {
  return withTransaction(async (client) => {
    const { rows: orderRows } = await client.query(
      `SELECT * FROM orders WHERE id = $1 AND restaurant_id = $2 AND status = 'OPEN' FOR UPDATE`,
      [orderId, restaurantId]
    );
    const order = orderRows[0];
    if (!order) throw Object.assign(new Error("Open order not found."), { status: 404 });
    assertRevision(order, expectedRevision);
    const { rows: itemCount } = await client.query("SELECT COUNT(*)::int AS count FROM order_items WHERE order_id = $1", [order.id]);
    if (!itemCount[0].count) throw validationError("An order needs at least one item before settlement.");
    const paidPaise = payments.reduce((sum, payment) => sum + toPaise(payment.amount), 0);
    const grandTotalPaise = toPaise(order.grand_total);
    if (paidPaise !== grandTotalPaise) {
      throw validationError(`Payment total must equal \u20B9${moneyToString(grandTotalPaise)}.`);
    }
    const { rows: restaurantRows } = await client.query(
      `SELECT name, address, phone, gstin, bill_prefix
       FROM restaurants WHERE id = $1 FOR SHARE`,
      [restaurantId]
    );
    const restaurant = restaurantRows[0];
    if (!restaurant) throw Object.assign(new Error("Restaurant not found."), { status: 404 });
    await client.query("DELETE FROM payments WHERE order_id = $1", [order.id]);
    for (const payment of payments) {
      await client.query(
        "INSERT INTO payments (order_id, method, amount, reference) VALUES ($1,$2,$3,$4)",
        [order.id, payment.method, moneyToString(toPaise(payment.amount)), payment.reference || null]
      );
    }
    await client.query(
      `UPDATE orders
       SET status = 'COMPLETED', payment_status = 'PAID', completed_by = $2, completed_at = now(),
           bill_print_requested_at = CASE WHEN $3 THEN now() ELSE bill_print_requested_at END,
           restaurant_name_snapshot = COALESCE(restaurant_name_snapshot, $4),
           restaurant_address_snapshot = COALESCE(restaurant_address_snapshot, $5),
           restaurant_phone_snapshot = COALESCE(restaurant_phone_snapshot, $6),
           restaurant_gstin_snapshot = COALESCE(restaurant_gstin_snapshot, $7),
           bill_prefix_snapshot = COALESCE(bill_prefix_snapshot, $8),
           customer_name = COALESCE(NULLIF($9, ''), customer_name), customer_mobile = COALESCE(NULLIF($10, ''), customer_mobile),
           revision = revision + 1, updated_at = now()
       WHERE id = $1`,
      [order.id, userId, Boolean(printBill), restaurant.name, restaurant.address, restaurant.phone, restaurant.gstin, restaurant.bill_prefix, customerName, customerMobile]
    );
    await recordOrderEvent(client, {
      orderId: order.id,
      restaurantId,
      userId,
      eventType: "SETTLED",
      payload: {
        grandTotal: moneyToNumber(grandTotalPaise),
        payments,
        customerDetailsSaved: Boolean(customerName || customerMobile)
      }
    });
    if (printBill) {
      await recordOrderEvent(client, {
        orderId: order.id,
        restaurantId,
        userId,
        eventType: "BILL_PRINT_REQUESTED",
        payload: { source: "browser-print" }
      });
    }
    return getOrder(client, restaurantId, order.id);
  });
}
async function reprintBill({ restaurantId, userId, authorizedByUserId, orderId }) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT id FROM orders
       WHERE id = $1 AND restaurant_id = $2 AND status = 'COMPLETED'
       FOR SHARE`,
      [orderId, restaurantId]
    );
    if (!rows[0]) throw Object.assign(new Error("Completed order not found."), { status: 404 });
    await recordAudit(client, restaurantId, userId, "BILL_REPRINT_REQUESTED", "ORDER", orderId, { authorizedByUserId: authorizedByUserId || null });
    return getOrder(client, restaurantId, orderId);
  });
}
async function voidOpenOrder({ restaurantId, userId, orderId, expectedRevision, reason }) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM orders
       WHERE id = $1 AND restaurant_id = $2 AND status = 'OPEN'
       FOR UPDATE`,
      [orderId, restaurantId]
    );
    const order = rows[0];
    if (!order) throw Object.assign(new Error("Open order not found."), { status: 404 });
    assertRevision(order, expectedRevision);
    const { rows: kotRows } = await client.query(
      `SELECT sequence, daily_kot_number, items, printed_at
       FROM kot_prints
       WHERE order_id = $1
       ORDER BY sequence`,
      [order.id]
    );
    const cancelKots = kotRows.map((kot) => ({
      sequence: Number(kot.sequence),
      dailyKotNumber: Number(kot.daily_kot_number || kot.sequence),
      items: parseSnapshot(kot.items),
      printedAt: (/* @__PURE__ */ new Date()).toISOString(),
      originalPrintedAt: kot.printed_at
    }));
    await client.query(
      `UPDATE orders
       SET status = 'VOID', void_reason = $2, voided_by = $3, void_authorized_by = NULL, voided_at = now(),
           revision = revision + 1, updated_at = now()
       WHERE id = $1`,
      [order.id, reason, userId]
    );
    await recordOrderEvent(client, {
      orderId: order.id,
      restaurantId,
      userId,
      eventType: "VOIDED",
      payload: { reason, authorization: "shared-void-password", cancelKotRequired: cancelKots.length > 0, cancelKots }
    });
    await recordAudit(client, restaurantId, userId, "ORDER_VOIDED", "ORDER", order.id, {
      reason,
      authorization: "shared-void-password",
      cancelKotRequired: cancelKots.length > 0,
      cancelledKotNumbers: cancelKots.map((kot) => kot.dailyKotNumber)
    });
    return {
      order: await getOrder(client, restaurantId, order.id),
      cancelKots
    };
  });
}
function normalizeOrder(order) {
  const numberFields = [
    "subtotal",
    "taxable_amount",
    "discount_value",
    "discount_amount",
    "cgst_amount",
    "sgst_amount",
    "gst_amount",
    "round_off",
    "grand_total",
    "container_charge",
    "container_gst_rate",
    "container_taxable_amount",
    "container_cgst_amount",
    "container_sgst_amount",
    "container_gst_amount"
  ];
  const normalized = { ...order };
  numberFields.forEach((field) => {
    normalized[field] = Number(normalized[field] || 0);
  });
  normalized.revision = Number(normalized.revision || 1);
  normalized.kot_sequence = Number(normalized.kot_sequence || 0);
  normalized.takeaway_token = normalized.takeaway_token == null ? null : Number(normalized.takeaway_token);
  normalized.order_type = normalized.order_type || 'DINE_IN';
  normalized.items = (normalized.items || []).map((item) => ({
    ...item,
    unit_price: Number(item.unit_price || 0),
    gst_rate: Number(item.gst_rate || 0),
    addon_unit_total: Number(item.addon_unit_total || 0),
    line_taxable_before_discount: Number(item.line_taxable_before_discount || 0),
    line_discount: Number(item.line_discount || 0),
    line_cgst: Number(item.line_cgst || 0),
    line_sgst: Number(item.line_sgst || 0),
    line_gst: Number(item.line_gst || 0),
    line_total: Number(item.line_total || 0),
    sent_to_kitchen_qty: Number(item.sent_to_kitchen_qty || 0),
    addons_snapshot: parseSnapshot(item.addons_snapshot),
    line_source: item.line_source || 'QR_CUSTOMER',
    added_by_user_id: item.added_by_user_id || null,
  }));
  normalized.payments = (normalized.payments || []).map((payment) => ({ ...payment, amount: Number(payment.amount || 0) }));
  return normalized;
}
async function getOrder(clientOrQuery, restaurantId, orderId) {
  const runner = clientOrQuery.query ? clientOrQuery : { query: clientOrQuery };
  const { rows: orderRows } = await runner.query(
    `SELECT o.*, t.name AS table_name,
            completed_by_user.display_name AS completed_by_name,
            COALESCE(o.restaurant_name_snapshot, r.name) AS restaurant_name,
            COALESCE(o.restaurant_address_snapshot, r.address) AS address,
            COALESCE(o.restaurant_phone_snapshot, r.phone) AS phone,
            COALESCE(o.restaurant_gstin_snapshot, r.gstin) AS gstin,
            COALESCE(o.bill_prefix_snapshot, r.bill_prefix) AS bill_prefix
     FROM orders o
     LEFT JOIN dining_tables t ON t.id = o.table_id
     LEFT JOIN users completed_by_user ON completed_by_user.id = o.completed_by
     JOIN restaurants r ON r.id = o.restaurant_id
     WHERE o.id = $1 AND o.restaurant_id = $2`,
    [orderId, restaurantId]
  );
  const order = orderRows[0];
  if (!order) return null;
  const { rows: items } = await runner.query(
    `SELECT id, menu_item_id, item_name, unit_price, gst_rate, gst_inclusive, quantity, sent_to_kitchen_qty,
            addons_snapshot, addon_unit_total, line_taxable_before_discount, line_discount,
            line_cgst, line_sgst, line_gst, line_total, line_source, added_by_user_id
     FROM order_items WHERE order_id = $1 ORDER BY created_at`,
    [order.id]
  );
  const { rows: payments } = await runner.query(
    "SELECT method, amount, reference, created_at FROM payments WHERE order_id = $1 ORDER BY created_at",
    [order.id]
  );
  return normalizeOrder({ ...order, items, payments });
}
export {
  getOrder,
  printDraftBill,
  printKot,
  reprintBill,
  reprintLatestKot,
  saveDraft,
  settleOrder,
  voidOpenOrder
};

/**
 * DirectQR-only operator action. Staff may append items to an already accepted
 * QR table bill, but cannot create a blank/manual table order through this API.
 */
export async function addStaffItems({ restaurantId, userId, orderId, expectedRevision, items, note = '' }) {
  return withTransaction(async (client) => {
    const { rows: orderRows } = await client.query(
      `SELECT * FROM orders
       WHERE id = $1 AND restaurant_id = $2 AND status = 'OPEN'
       FOR UPDATE`,
      [orderId, restaurantId],
    );
    const order = orderRows[0];
    if (!order) throw Object.assign(new Error('Open DirectQR order not found.'), { status: 404 });
    if ((order.order_source || 'DIRECT_QR') !== 'DIRECT_QR') {
      throw Object.assign(new Error('Only DirectQR-originated table orders can be changed here.'), { status: 403 });
    }
    if (order.bill_locked_at) throw validationError('This bill was printed and is awaiting payment. Settle it or void it before adding items.');
    assertRevision(order, expectedRevision);
    const { rows: existingItems } = await client.query(
      `SELECT menu_item_id, quantity, addons_snapshot
       FROM order_items WHERE order_id = $1 ORDER BY created_at FOR UPDATE`,
      [order.id],
    );
    const merged = new Map();
    for (const existing of existingItems) {
      if (!existing.menu_item_id) continue;
      const row = {
        menuItemId: existing.menu_item_id,
        quantity: Number(existing.quantity),
        addonOptionIds: parseSnapshot(existing.addons_snapshot).map((addon) => addon?.id).filter(Boolean).sort(),
      };
      merged.set(itemKeyFromRequested(row), row);
    }
    for (const requested of items) {
      const row = {
        menuItemId: requested.menuItemId,
        quantity: Number(requested.quantity),
        addonOptionIds: Array.isArray(requested.addonOptionIds) ? [...requested.addonOptionIds].sort() : [],
      };
      const key = itemKeyFromRequested(row);
      const current = merged.get(key);
      if (current) current.quantity += row.quantity;
      else merged.set(key, row);
    }
    const result = await upsertDraftOrder(client, {
      restaurantId,
      userId,
      orderId: order.id,
      expectedRevision,
      draft: {
        orderType: 'DINE_IN',
        tableId: order.table_id,
        items: [...merged.values()],
        discountType: order.discount_type || null,
        discountValue: order.discount_value || 0,
        containerCharge: Number(order.container_charge || 0),
        notes: order.notes || null,
      },
      lineSource: 'STAFF',
    });
    await recordAudit(client, restaurantId, userId, 'DIRECTQR_STAFF_ITEMS_ADDED', 'ORDER', order.id, {
      itemCount: items.length,
      note: String(note || '').slice(0, 300) || null,
      source: 'STAFF',
    });
    return { ...result, order: await getOrder(client, restaurantId, order.id) };
  });
}
