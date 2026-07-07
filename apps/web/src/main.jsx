import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { calculateCart } from "@directqr/core/tax";
import QRCode from "qrcode";
import JSZip from "jszip";
import { api, superApi } from "./api";
import "./styles.css";
const rupees = (value) => new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  maximumFractionDigits: 2
}).format(Number(value || 0));
const signedRupees = (value) => {
  const amount = Number(value || 0);
  if (amount > 0) return `+ ${rupees(amount)}`;
  if (amount < 0) return `\u2212 ${rupees(Math.abs(amount))}`;
  return rupees(0);
};
function formatPercent(value) {
  const number = Number(value || 0);
  return Number.isInteger(number) ? String(number) : number.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}
function gstRateLabel(rate) {
  return `GST @ ${formatPercent(rate)}%`;
}
function foodTypeLabel(type) {
  return type === "NON_VEG" ? "NON-VEG" : "VEG";
}
function taxBreakupLabels(lines) {
  const rates = [...new Set(lines.map((line) => Number(line.item?.gstRate ?? line.gst_rate ?? 0)).filter((rate) => rate > 0))];
  if (rates.length === 1) {
    const half = rates[0] / 2;
    return { cgst: `CGST @ ${formatPercent(half)}%`, sgst: `SGST @ ${formatPercent(half)}%` };
  }
  if (rates.length > 1) return { cgst: "CGST (mixed rates)", sgst: "SGST (mixed rates)" };
  return { cgst: "CGST", sgst: "SGST" };
}
function discountLabel(type, value) {
  if (type === "PERCENT") return `Discount (${formatPercent(value)}%)`;
  if (type === "FIXED") return `Discount (${rupees(value)})`;
  return "Discount";
}
function indiaToday() {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(/* @__PURE__ */ new Date());
  const part = (type) => parts.find((entry) => entry.type === type)?.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}
function outletStatus(session) {
  const zone = session.timezone || "Asia/Kolkata";
  const nowText = new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", minute: "2-digit", hour12: false }).format(/* @__PURE__ */ new Date());
  const now = nowText.split(":").map(Number).reduce((value, part, index) => value + part * (index === 0 ? 60 : 1), 0);
  const parse = (time) => String(time || "00:00").slice(0, 5).split(":").map(Number).reduce((value, part, index) => value + part * (index === 0 ? 60 : 1), 0);
  return now >= parse(session.openingTime) && now < parse(session.closingTime) ? "OPEN" : "CLOSED";
}
const PERMISSION_LABELS = {
  view_tables: "View tables",
  create_orders: "Create and save orders",
  send_kot: "Send and reprint KOT",
  print_bill: "Print bill",
  settle_payment: "Settle payment",
  view_reports: "View reports",
  view_customer_details: "View customer details",
  edit_menu: "Edit menu and add-ons",
  manage_tables: "Add and delete tables",
  void_orders: "Void with Void Password",
  reprint_bill: "Reprint bills",
  apply_discount: "Apply discounts"
};
const ROLE_TEMPLATES = {
  WAITER: { view_tables: true, create_orders: true, send_kot: true, print_bill: false, settle_payment: false, view_reports: false, view_customer_details: false, edit_menu: false, manage_tables: false, void_orders: true, reprint_bill: false, apply_discount: false },
  CASHIER: { view_tables: true, create_orders: true, send_kot: true, print_bill: true, settle_payment: true, view_reports: true, view_customer_details: true, edit_menu: false, manage_tables: false, void_orders: true, reprint_bill: true, apply_discount: false },
  MANAGER: { view_tables: true, create_orders: true, send_kot: true, print_bill: true, settle_payment: true, view_reports: true, view_customer_details: true, edit_menu: true, manage_tables: true, void_orders: true, reprint_bill: true, apply_discount: true }
};
function roleLabel(role) {
  return role === "OWNER" ? "Admin" : role.charAt(0) + role.slice(1).toLowerCase();
}
function tableStatus(table) {
  if (!table.open_order_id) return { key: "FREE", label: "FREE", tone: "free" };
  if (table.bill_locked_at) return { key: "PAYMENT_PENDING", label: "PAYMENT PENDING", tone: "pending" };
  if (!Number(table.kot_sequence || 0)) return { key: "ORDER_OPEN", label: "ORDER OPEN", tone: "active" };
  if (Number(table.unsent_item_count || 0) > 0) return { key: "KOT_PENDING", label: "KOT PENDING", tone: "pending" };
  return { key: "KOT_SENT", label: "KOT SENT", tone: "sent" };
}
function useToast() {
  const [toast, setToast] = useState(null);
  const show = useCallback((message, type = "success") => {
    setToast({ message, type });
    window.setTimeout(() => setToast(null), 3500);
  }, []);
  return { toast, show };
}
function useActionDialog() {
  const [request, setRequest] = useState(null);
  const resolverRef = useRef(null);
  const open = useCallback((kind, options = {}) => new Promise((resolve) => {
    resolverRef.current = resolve;
    setRequest({ id: crypto.randomUUID(), kind, ...options });
  }), []);
  const close = useCallback((value) => {
    const resolve = resolverRef.current;
    resolverRef.current = null;
    setRequest(null);
    if (resolve) resolve(value);
  }, []);
  return {
    confirm: (options) => open("confirm", options),
    requestForm: (options) => open("form", options),
    element: request ? <ActionDialog key={request.id} request={request} onResolve={close} /> : null
  };
}
function ActionDialog({ request, onResolve }) {
  const fields = request.fields || [];
  const [values, setValues] = useState(() => Object.fromEntries(fields.map((field) => [field.name, field.initialValue ?? ""])));
  const [validation, setValidation] = useState("");
  const closeValue = request.kind === "confirm" ? false : null;
  const submit = (event) => {
    event.preventDefault();
    if (request.kind === "confirm") {
      onResolve(true);
      return;
    }
    const result = {};
    for (const field of fields) {
      const raw = String(values[field.name] ?? "");
      const value = field.type === "password" ? raw : raw.trim();
      if (field.required && !value) {
        setValidation(`${field.label} is required.`);
        return;
      }
      if (field.minLength && value.length < field.minLength) {
        setValidation(`${field.label} must contain at least ${field.minLength} characters.`);
        return;
      }
      result[field.name] = value;
    }
    onResolve(result);
  };
  return <Modal title={request.title || "Confirm action"} onClose={() => onResolve(closeValue)}>
      <form className="action-dialog-form" onSubmit={submit}>
        {request.message && <p className="muted action-dialog-message">{request.message}</p>}
        {fields.map((field, index) => <label key={field.name}>
            {field.label}
            {field.type === "textarea" ? <textarea
    autoFocus={index === 0}
    value={values[field.name] ?? ""}
    placeholder={field.placeholder || ""}
    maxLength={field.maxLength}
    onChange={(event) => {
      setValues((old) => ({ ...old, [field.name]: event.target.value }));
      setValidation("");
    }}
  /> : <input
    autoFocus={index === 0}
    type={field.type || "text"}
    value={values[field.name] ?? ""}
    placeholder={field.placeholder || ""}
    maxLength={field.maxLength}
    autoComplete={field.autoComplete || "off"}
    data-lpignore={field.type === "password" ? "true" : void 0}
    data-1p-ignore={field.type === "password" ? "true" : void 0}
    onChange={(event) => {
      setValues((old) => ({ ...old, [field.name]: event.target.value }));
      setValidation("");
    }}
  />}
            {field.help && <small className="form-help">{field.help}</small>}
          </label>)}
        {validation && <p className="dialog-error" role="alert">{validation}</p>}
        <div className="modal-actions">
          <button type="button" className="outline" onClick={() => onResolve(closeValue)}>Cancel</button>
          <button className={`primary ${request.tone === "danger" ? "danger-primary" : ""}`} type="submit">{request.confirmLabel || "Confirm"}</button>
        </div>
      </form>
    </Modal>;
}
function ForgeArcLogo({ className = "" }) {
  return <svg className={`forgearc-logo directqr-logo ${className}`.trim()} viewBox="0 0 48 48" role="img" aria-label="DirectQR">
    <rect x="4" y="4" width="40" height="40" rx="12" fill="#0b1113" />
    <path d="M13 20v-5a2 2 0 0 1 2-2h5M28 13h5a2 2 0 0 1 2 2v5M35 28v5a2 2 0 0 1-2 2h-5M20 35h-5a2 2 0 0 1-2-2v-5" stroke="#20d6c7" strokeWidth="2.7" fill="none" strokeLinecap="round" />
    <rect x="18" y="18" width="5" height="5" rx="1" fill="#ffffff" />
    <rect x="26" y="18" width="5" height="5" rx="1" fill="#20d6c7" />
    <rect x="18" y="26" width="5" height="5" rx="1" fill="#20d6c7" />
    <rect x="26" y="26" width="5" height="5" rx="1" fill="#ffffff" />
  </svg>;
}
function Icon({ name, size = 18, strokeWidth = 1.9, className = "", ...props }) {
  const common = { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true, className: `fa-icon ${className}`.trim(), ...props };
  const paths = {
    dashboard: <><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></>,
    tables: <><rect x="4" y="4" width="16" height="16" rx="2" /><path d="M4 10h16M10 4v16" /></>,
    receipt: <><path d="M6 3h12v18l-3-2-3 2-3-2-3 2V3Z" /><path d="M9 8h6M9 12h6M9 16h3" /></>,
    menu: <><path d="M5 7h14M5 12h14M5 17h14" /><circle cx="3" cy="7" r=".6" fill="currentColor" stroke="none" /><circle cx="3" cy="12" r=".6" fill="currentColor" stroke="none" /><circle cx="3" cy="17" r=".6" fill="currentColor" stroke="none" /></>,
    more: <><circle cx="5" cy="12" r="1" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" /><circle cx="19" cy="12" r="1" fill="currentColor" stroke="none" /></>,
    settings: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.14 2.14-.06-.06a1.7 1.7 0 0 0-1.88-.34 1.7 1.7 0 0 0-1.03 1.55V20.5h-3.02v-.09a1.7 1.7 0 0 0-1.03-1.55 1.7 1.7 0 0 0-1.88.34l-.06.06-2.14-2.14.06-.06A1.7 1.7 0 0 0 7 15.18 1.7 1.7 0 0 0 5.45 14.15h-.09v-3.02h.09A1.7 1.7 0 0 0 7 10.1a1.7 1.7 0 0 0-.34-1.88l-.06-.06L8.74 6l.06.06a1.7 1.7 0 0 0 1.88.34 1.7 1.7 0 0 0 1.03-1.55v-.09h3.02v.09a1.7 1.7 0 0 0 1.03 1.55 1.7 1.7 0 0 0 1.88-.34L17.7 6l2.14 2.14-.06.06a1.7 1.7 0 0 0-.34 1.88 1.7 1.7 0 0 0 1.55 1.03h.09v3.02h-.09A1.7 1.7 0 0 0 19.4 15Z" /></>,
    user: <><circle cx="12" cy="8" r="3.2" /><path d="M5.5 20c.7-3.3 3.1-5.2 6.5-5.2S17.8 16.7 18.5 20" /></>,
    note: <><path d="M5 4h14v16H5z" /><path d="M8 8h8M8 12h8M8 16h5" /></>,
    search: <><circle cx="10.5" cy="10.5" r="5.5" /><path d="m15 15 4.2 4.2" /></>,
    chevronDown: <path d="m7 10 5 5 5-5" />,
    chevronUp: <path d="m7 14 5-5 5 5" />,
    plus: <><path d="M12 5v14M5 12h14" /></>,
    trash: <><path d="M4 7h16M10 11v6M14 11v6M9 7V4h6v3M6 7l1 14h10l1-14" /></>,
    printer: <><path d="M7 8V3h10v5" /><rect x="4" y="8" width="16" height="9" rx="2" /><path d="M7 17h10v4H7zM17 12h.01" /></>,
    download: <><path d="M12 3v11" /><path d="m8 10 4 4 4-4" /><path d="M5 21h14" /></>,
    refresh: <><path d="M20 11a8 8 0 1 0 2 5.4" /><path d="M20 4v7h-7" /></>,
    bell: <><path d="M18 9a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" /><path d="M10 21h4" /></>,
    qr: <><rect x="3.5" y="3.5" width="6" height="6" /><rect x="14.5" y="3.5" width="6" height="6" /><rect x="3.5" y="14.5" width="6" height="6" /><path d="M14.5 14.5h2v2h-2zM18.5 14.5h2v3h-2zM14.5 18.5h3v2h-3zM19.5 19.5h1v1h-1z" /></>,
    link: <><path d="M10 13a5 5 0 0 0 7.07.07l2-2a5 5 0 0 0-7.07-7.07l-1.15 1.15" /><path d="M14 11a5 5 0 0 0-7.07-.07l-2 2A5 5 0 0 0 12 20l1.15-1.15" /></>,
    bill: <><path d="M7 3h10v18l-2.5-1.5L12 21l-2.5-1.5L7 21V3Z" /><path d="M10 8h4M10 12h4M10 16h3" /></>,
    wallet: <><path d="M4 7.5A2.5 2.5 0 0 1 6.5 5H19v14H6.5A2.5 2.5 0 0 1 4 16.5v-9Z" /><path d="M4 8h14" /><path d="M15 13h4" /></>,
    arrowLeft: <path d="m14 6-6 6 6 6M8 12h12" />,
    takeaway: <><path d="M4 9h16l-1 11H5L4 9Z" /><path d="M8 9V7a4 4 0 0 1 8 0v2" /></>,
    close: <path d="m6 6 12 12M18 6 6 18" />
  };
  return <svg {...common}>{paths[name] || paths.more}</svg>;
}
function formatTakeawayToken(value) {
  const number = Number(value || 0);
  return number > 0 ? `TAKEAWAY #${String(number).padStart(2, "0")}` : "TAKEAWAY";
}
function orderLocationLabel(order) {
  const type = order?.orderType || order?.order_type || "DINE_IN";
  if (type === "TAKEAWAY") return formatTakeawayToken(order?.takeawayToken ?? order?.takeaway_token);
  return order?.tableName || order?.table_name || order?.name || "Table";
}
function paymentSummary(order) {
  const parts = (order.payments || []).filter((payment) => Number(payment.amount || 0) > 0).map((payment) => `${payment.method} ${rupees(payment.amount)}`);
  return parts.length ? parts.join(" \xB7 ") : "\u2014";
}
function paymentAmount(order, method) {
  return (order.payments || []).reduce((sum, payment) => payment.method === method ? sum + Number(payment.amount || 0) : sum, 0);
}
function csvCell(value) {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}
function downloadCsv(filename, rows) {
  const csv = `\uFEFF${rows.map((row) => row.map(csvCell).join(",")).join("\r\n")}`;
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}
function reportNumber(value) {
  return Number(value || 0).toFixed(2);
}
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  return Uint8Array.from([...rawData].map((character) => character.charCodeAt(0)));
}
function App() {
  if (window.location.pathname.startsWith('/super-admin')) return <SuperAdminApp />;
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(true);
  const { toast, show } = useToast();
  useEffect(() => {
    api("/auth/me").then((data) => setSession(data.user)).catch(() => setSession(null)).finally(() => setLoading(false));
  }, []);
  if (loading) return <div className="loading-screen">Loading DirectQR…</div>;
  if (!session) return <Login onLogin={setSession} show={show} />;
  if (session.mustChangePassword) return <ForcedPasswordChange session={session} show={show} onComplete={() => setSession(null)} />;
  if (session.restaurantStatus === 'SETUP_PENDING') return <OutletSetupPending session={session} onLogout={async () => { try { await api('/auth/logout', { method: 'POST' }); } finally { setSession(null); } }} />;
  return <PosShell
    session={session}
    onSessionChange={setSession}
    toast={toast}
    show={show}
    onLogout={async () => {
      try {
        await api("/auth/logout", { method: "POST" });
      } finally {
        setSession(null);
      }
    }}
  />;
}
function Login({ onLogin, show }) {
  const [mode, setMode] = useState("STAFF");
  const [restaurantId, setRestaurantId] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [lockoutUntil, setLockoutUntil] = useState(null);
  const [now, setNow] = useState(Date.now());
  const [resetRequired, setResetRequired] = useState(false);
  useEffect(() => {
    if (!lockoutUntil) return void 0;
    const timer = window.setInterval(() => setNow(Date.now()), 1e3);
    return () => window.clearInterval(timer);
  }, [lockoutUntil]);
  const remainingSeconds = lockoutUntil ? Math.max(0, Math.ceil((new Date(lockoutUntil).getTime() - now) / 1e3)) : 0;
  const locked = remainingSeconds > 0;
  const lockoutLabel = `${Math.floor(remainingSeconds / 60)}:${String(remainingSeconds % 60).padStart(2, "0")}`;
  const switchMode = (nextMode) => {
    setMode(nextMode);
    setPassword("");
    setLockoutUntil(null);
    setResetRequired(false);
  };
  const submit = async (event) => {
    event.preventDefault();
    if (locked || resetRequired) return;
    setBusy(true);
    try {
      const data = await api("/auth/login", { method: "POST", body: JSON.stringify({ restaurantId: restaurantId.trim().toUpperCase(), username, password, mode }) });
      onLogin(data.user);
    } catch (error) {
      setLockoutUntil(error.lockoutUntil || null);
      setResetRequired(Boolean(error.passwordResetRequired));
      show(error.message, "error");
    } finally {
      setBusy(false);
    }
  };
  const isAdmin = mode === "ADMIN";
  return <main className="login-page">
      <section className="login-card">
        <div className="login-brand-lockup"><ForgeArcLogo className="login-logo" /><div><p className="eyebrow">DIRECTQR</p><h1>DirectQR</h1></div></div>
        <div className="login-mode-tabs" role="tablist" aria-label="Choose sign in type">
          <button type="button" role="tab" aria-selected={!isAdmin} className={!isAdmin ? "active" : ""} onClick={() => switchMode("STAFF")}>Staff sign in</button>
          <button type="button" role="tab" aria-selected={isAdmin} className={isAdmin ? "active" : ""} onClick={() => switchMode("ADMIN")}>Admin sign in</button>
        </div>
        <p className="muted login-mode-description">{isAdmin ? "Owner access for business controls and staff accounts." : "Operational access for tables, KOTs, reports and menu management."}</p>
        {locked && <div className="login-lockout" role="alert"><strong>Sign-in temporarily locked</strong><span>Try again in {lockoutLabel}.</span></div>}
        {resetRequired && <div className="login-lockout reset" role="alert"><strong>Admin password reset required</strong><span>Ask an Admin to reset this staff account before trying again.</span></div>}
        <form onSubmit={submit} autoComplete="off">
          <label>Restaurant ID<input value={restaurantId} onChange={(event) => setRestaurantId(event.target.value.toUpperCase())} autoComplete="off" autoCapitalize="characters" spellCheck={false} data-lpignore="true" data-1p-ignore="true" minLength="12" maxLength="32" pattern="[A-Za-z0-9]{12,32}" required /></label>
          <label>{isAdmin ? "Admin username" : "Staff username"}<input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="off" spellCheck={false} data-lpignore="true" data-1p-ignore="true" required /></label>
          <label>Password<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="off" data-lpignore="true" data-1p-ignore="true" minLength="12" required /></label>
          <button className="primary wide" disabled={busy || locked || resetRequired}>{busy ? "Signing in\u2026" : isAdmin ? "Sign in as admin" : "Sign in as staff"}</button>
        </form>
      </section>
    </main>;
}

function ForcedPasswordChange({ session, show, onComplete }) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (event) => {
    event.preventDefault();
    if (newPassword !== confirmPassword) {
      show('The new-password fields do not match.', 'error');
      return;
    }
    setBusy(true);
    try {
      await api('/auth/change-password', { method: 'POST', body: JSON.stringify({ currentPassword, newPassword }) });
      show('Password updated. Sign in again with your new password.');
      onComplete();
    } catch (error) {
      show(error.message, 'error');
    } finally {
      setBusy(false);
    }
  };
  return <main className="login-page"><section className="login-card forced-password-card">
    <div className="login-brand-lockup"><ForgeArcLogo className="login-logo" /><div><p className="eyebrow">SECURITY REQUIRED</p><h1>Set a new password</h1></div></div>
    <p className="muted">{session.displayName}, this owner account was created or reset by DirectQR. Change the temporary password before accessing the DirectQR console.</p>
    <form onSubmit={submit} autoComplete="off">
      <label>Temporary password<input type="password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} required /></label>
      <label>New password<input type="password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} minLength="12" required /></label>
      <label>Confirm new password<input type="password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} minLength="12" required /></label>
      <small className="form-help">Use at least 12 characters, including uppercase, lowercase, a number, and a symbol.</small>
      <button className="primary wide" disabled={busy}>{busy ? 'Saving…' : 'Save new password'}</button>
    </form>
  </section></main>;
}

function OutletSetupPending({ session, onLogout }) {
  return <main className="login-page"><section className="login-card outlet-setup-card"><div className="login-brand-lockup"><ForgeArcLogo className="login-logo" /><div><p className="eyebrow">DIRECTQR ONBOARDING</p><h1>Setup in progress</h1></div></div><p className="muted">{session.displayName}, your restaurant is being configured by DirectQR. DirectQR console access will unlock automatically after the required setup checklist is completed.</p><p className="form-help">Restaurant: {session.restaurantName}</p><button className="outline wide" onClick={onLogout}>Log out</button></section></main>;
}

function SuperAdminApp() {
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(true);
  const { toast, show } = useToast();
  useEffect(() => {
    superApi('/auth/me').then((data) => setSession(data.superAdmin)).catch(() => setSession(null)).finally(() => setLoading(false));
  }, []);
  if (loading) return <div className="loading-screen">Loading DirectQR Super Admin…</div>;
  if (!session) return <SuperAdminLogin onLogin={setSession} show={show} />;
  return <SuperAdminShell session={session} onLogout={async () => {
    try { await superApi('/auth/logout', { method: 'POST' }); } finally { setSession(null); }
  }} show={show} toast={toast} />;
}

function SuperAdminLogin({ onLogin, show }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    try {
      const data = await superApi('/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) });
      onLogin(data.superAdmin);
    } catch (error) {
      show(error.message, 'error');
    } finally {
      setBusy(false);
    }
  };
  return <main className="login-page super-admin-login"><section className="login-card">
    <div className="login-brand-lockup"><ForgeArcLogo className="login-logo" /><div><p className="eyebrow">DIRECTQR CONTROL</p><h1>Super Admin</h1></div></div>
    <p className="muted login-mode-description">Private control layer for DirectQR restaurant onboarding, annual licences, support access and controlled configuration.</p>
    <form onSubmit={submit} autoComplete="off">
      <label>Super Admin username<input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" required /></label>
      <label>Password<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" required /></label>
      <button className="primary wide" disabled={busy}>{busy ? 'Signing in…' : 'Sign in to control center'}</button>
    </form>
  </section></main>;
}

function SuperAdminShell({ session, onLogout, show, toast }) {
  const [restaurants, setRestaurants] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [newCredentials, setNewCredentials] = useState(null);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await superApi('/restaurants');
      setRestaurants(data.restaurants || []);
    } catch (error) {
      show(error.message, 'error');
    } finally {
      setLoading(false);
    }
  }, [show]);
  useEffect(() => { load(); }, [load]);
  const selected = restaurants.find((restaurant) => restaurant.id === selectedId) || null;
  const created = (data) => {
    setCreateOpen(false);
    setNewCredentials({ restaurantName: data.restaurant.name, ownerUsername: data.restaurant.owner?.username, temporaryPassword: data.temporaryOwnerPassword });
    setSelectedId(data.restaurant.id);
    load();
    show('Restaurant created. Copy the temporary owner password now.');
  };
  return <div className="super-admin-shell">
    <header className="super-admin-header">
      <div className="super-admin-brand"><ForgeArcLogo className="sidebar-logo" /><div><span>DIRECTQR CONTROL</span><strong>Super Admin</strong></div></div>
      <div className="super-admin-account"><span>{session.displayName}</span><button className="outline" onClick={onLogout}>Log out</button></div>
    </header>
    <main className="super-admin-main">
      {!selectedId ? <SuperAdminRestaurantList restaurants={restaurants} loading={loading} onCreate={() => setCreateOpen(true)} onOpen={setSelectedId} onRefresh={load} /> : <SuperAdminRestaurantDetail restaurantId={selectedId} onBack={() => { setSelectedId(null); load(); }} onChanged={load} show={show} />}
    </main>
    {createOpen && <SuperAdminCreateRestaurant onClose={() => setCreateOpen(false)} onCreated={created} show={show} />}
    {newCredentials && <OwnerCredentialsNotice credentials={newCredentials} onClose={() => setNewCredentials(null)} />}
    {toast && <div className={`toast ${toast.type}`} role="status">{toast.message}</div>}
  </div>;
}

function statusClass(value) {
  return String(value || '').toLowerCase().replace(/_/g, '-');
}
function statusLabel(value) { return String(value || '—').replace(/_/g, ' '); }
function commercialStatusTone(value) {
  return ['PAID', 'ACTIVE'].includes(value) ? 'success' : ['DUE', 'DUE_SOON'].includes(value) ? 'warning' : ['OVERDUE', 'EXPIRED', 'SUSPENDED', 'DISABLED'].includes(value) ? 'danger' : 'muted';
}
function superAdminFieldErrors(error) {
  return Object.fromEntries((Array.isArray(error?.details) ? error.details : []).map((detail) => [detail.path, detail.message]));
}
function FieldError({ message }) { return message ? <small className="field-error" role="alert">{message}</small> : null; }
function dateParts(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
  if (!match) return null;
  const [, y, m, d] = match.map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d ? { y, m, d } : null;
}
function daysInCalendarMonth(year, month) { return new Date(Date.UTC(year, month, 0)).getUTCDate(); }
function dateFromParts({ y, m, d }) { return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`; }
function addCalendarYearsInput(value, years = 1) {
  const parts = dateParts(value); if (!parts) return '';
  const y = parts.y + years; return dateFromParts({ y, m: parts.m, d: Math.min(parts.d, daysInCalendarMonth(y, parts.m)) });
}
function addCalendarMonthsInput(value, months = 1) {
  const parts = dateParts(value); if (!parts) return '';
  const absoluteMonth = (parts.y * 12) + (parts.m - 1) + months;
  const y = Math.floor(absoluteMonth / 12); const m = (absoluteMonth % 12) + 1;
  return dateFromParts({ y, m, d: Math.min(parts.d, daysInCalendarMonth(y, m)) });
}
function nullDates(payload) {
  return Object.fromEntries(Object.entries(payload).map(([key, value]) => [key, key.endsWith('Date') && value === '' ? null : value]));
}

function SuperAdminRestaurantList({ restaurants, loading, onCreate, onOpen, onRefresh }) {
  return <section className="super-admin-page">
    <header className="super-admin-page-header"><div><p className="eyebrow">CLIENT OPERATIONS</p><h1>Restaurants</h1><p className="muted">Provision DirectQR clients, monitor licence/support status, and open auditable support sessions.</p></div><div className="header-actions"><button className="outline" onClick={onRefresh}>Refresh</button><button className="primary" onClick={onCreate}><Icon name="plus" size={16} />Create DirectQR restaurant</button></div></header>
    {loading ? <div className="empty">Loading restaurants…</div> : !restaurants.length ? <div className="empty">No restaurants have been provisioned yet.</div> : <div className="super-admin-restaurant-grid">{restaurants.map((restaurant) => <button type="button" className="super-admin-restaurant-card" onClick={() => onOpen(restaurant.id)} key={restaurant.id}>
      <div className="super-admin-card-head"><div><span className="eyebrow">{restaurant.forgeArcRestaurantId}</span><h2>{restaurant.name}</h2><p>{restaurant.slug}</p></div><span className={`status-pill ${statusClass(restaurant.operationalStatus)}`}>{statusLabel(restaurant.operationalStatus)}</span></div>
      <div className="super-admin-card-metrics"><div><span>Base</span><b className={`metric-status ${commercialStatusTone(restaurant.commercial.basePaymentStatus)}`}>{statusLabel(restaurant.commercial.basePaymentStatus)}</b></div><div><span>Support</span><b className={`metric-status ${commercialStatusTone(restaurant.commercial.supportPaymentStatus)}`}>{statusLabel(restaurant.commercial.supportPaymentStatus)}</b></div><div><span>Console</span><b className={`metric-status ${restaurant.directQrOrdering ? 'success' : 'muted'}`}>{restaurant.directQrOrdering ? 'Enabled' : 'Off'}</b></div></div>
      <footer><span>{restaurant.owner?.username ? `Owner: ${restaurant.owner.username}` : 'Owner account missing'}</span><strong>Setup {restaurant.setup.completed}/{restaurant.setup.total}</strong></footer>
    </button>)}</div>}
  </section>;
}

function OwnerCredentialsNotice({ credentials, onClose }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(credentials.temporaryPassword); setCopied(true); } catch { /* browsers may deny clipboard on HTTP */ }
  };
  return <Modal title="Temporary owner password" onClose={onClose}><div className="credential-notice"><p><strong>{credentials.restaurantName}</strong> was created. This password is displayed only now. Send it securely to the owner and instruct them to change it on their first login.</p><label>Owner username<input readOnly value={credentials.ownerUsername || ''} /></label><label>Temporary password<div className="credential-copy-row"><input readOnly value={credentials.temporaryPassword || ''} /><button type="button" className="outline" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button></div></label><div className="modal-actions"><button className="primary" onClick={onClose}>I have saved it</button></div></div></Modal>;
}

function SuperAdminCreateRestaurant({ onClose, onCreated, show }) {
  const [form, setForm] = useState({ name: '', slug: '', ownerDisplayName: '', ownerUsername: '' });
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const update = (key, value) => { setForm((current) => ({ ...current, [key]: value })); setErrors((current) => ({ ...current, [key]: '' })); };
  const validate = () => {
    const next = {};
    if (!form.name.trim()) next.name = 'Enter the restaurant name.';
    if (form.slug && !/^[a-z0-9-]{2,80}$/.test(form.slug)) next.slug = 'Use 2–80 lowercase letters, numbers or hyphens.';
    if (form.ownerDisplayName.trim().length < 2) next.ownerDisplayName = 'Enter the owner name.';
    if (!/^[a-z0-9._-]{3,64}$/.test(form.ownerUsername)) next.ownerUsername = 'Use 3–64 letters, numbers, dots, underscores or hyphens.';
    setErrors(next);
    return Object.keys(next).length === 0;
  };
  const submit = async (event) => {
    event.preventDefault();
    if (!validate()) return;
    setBusy(true);
    try {
      const payload = { ...form, name: form.name.trim(), slug: form.slug.trim(), ownerDisplayName: form.ownerDisplayName.trim(), ownerUsername: form.ownerUsername.trim().toLowerCase() };
      onCreated(await superApi('/restaurants', { method: 'POST', body: JSON.stringify(payload) }));
    } catch (error) {
      setErrors(superAdminFieldErrors(error));
      show(error.message, 'error');
    } finally { setBusy(false); }
  };
  return <Modal title="Create restaurant" onClose={onClose} variant="super-admin-modal"><form className="super-admin-form create-restaurant-form" onSubmit={submit} noValidate>
    <section><p className="eyebrow">RESTAURANT IDENTITY</p><div className="super-admin-form-grid"><label>Restaurant name<input value={form.name} aria-invalid={Boolean(errors.name)} onChange={(event) => update('name', event.target.value)} required /><FieldError message={errors.name} /></label><label>DirectQR slug <small>Optional. DirectQR generates a safe URL slug when left blank.</small><input value={form.slug} aria-invalid={Boolean(errors.slug)} onChange={(event) => update('slug', event.target.value.toLowerCase())} placeholder="coffea-bareilly" /><FieldError message={errors.slug} /></label></div><p className="form-help">DirectQR Restaurant ID is generated automatically. DirectQR licence and technical-support records are configured only after setup is complete and the restaurant becomes active.</p></section>
    <section><p className="eyebrow">FIRST OWNER</p><div className="super-admin-form-grid"><label>Owner display name<input value={form.ownerDisplayName} aria-invalid={Boolean(errors.ownerDisplayName)} onChange={(event) => update('ownerDisplayName', event.target.value)} required /><FieldError message={errors.ownerDisplayName} /></label><label>Owner username<input value={form.ownerUsername} aria-invalid={Boolean(errors.ownerUsername)} onChange={(event) => update('ownerUsername', event.target.value.toLowerCase())} autoCapitalize="none" spellCheck={false} placeholder="coffea.owner" required /><FieldError message={errors.ownerUsername} /></label></div><p className="form-help">DirectQR generates a temporary password, shows it once, and forces this owner to set a new password on first sign-in.</p></section>
    <div className="modal-actions"><button type="button" className="outline" onClick={onClose}>Cancel</button><button className="primary" disabled={busy}>{busy ? 'Creating…' : 'Create setup-pending restaurant'}</button></div>
  </form></Modal>;
}

function StatusSelect({ label, value, onChange, options, disabled = false, help = '' }) {
  return <label>{label}{help ? <small>{help}</small> : null}<select value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}>{options.map((option) => <option key={option} value={option}>{statusLabel(option)}</option>)}</select></label>;
}

function SuperAdminRestaurantDetail({ restaurantId, onBack, onChanged, show }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [activeTab, setActiveTab] = useState('overview');
  const [credentials, setCredentials] = useState(null);
  const [supportSession, setSupportSession] = useState(null);
  const hasLoadedRef = useRef(false);
  const load = useCallback(async ({ initial = false } = {}) => {
    const isInitialLoad = initial || !hasLoadedRef.current;
    if (isInitialLoad) setLoading(true);
    else setRefreshing(true);
    try {
      setData(await superApi(`/restaurants/${restaurantId}`));
      hasLoadedRef.current = true;
    } catch (error) {
      show(error.message, 'error');
    } finally {
      if (isInitialLoad) setLoading(false);
      else setRefreshing(false);
    }
  }, [restaurantId, show]);
  useEffect(() => {
    hasLoadedRef.current = false;
    setData(null);
    setLoading(true);
    setSupportSession(null);
    setActiveTab('overview');
    load({ initial: true });
  }, [restaurantId, load]);
  useEffect(() => { if (data?.restaurant?.operationalStatus === 'SETUP_PENDING') setActiveTab('overview'); }, [data?.restaurant?.operationalStatus]);
  useEffect(() => {
    if (supportSession && data?.restaurant?.operationalStatus !== 'SETUP_PENDING') setActiveTab('support');
  }, [data?.restaurant?.operationalStatus, supportSession]);
  const updated = async (result = null) => {
    if (result?.restaurant) setData(result);
    await load();
    onChanged();
  };
  if (loading || !data) return <section className="super-admin-page"><button className="text-button" onClick={onBack}>← Restaurants</button><div className="empty">Loading restaurant…</div></section>;
  const { restaurant, auditLogs } = data;
  const inSetup = restaurant.operationalStatus === 'SETUP_PENDING';
  const unlockTabs = !inSetup;
  const resetOwnerPassword = async () => {
    if (!window.confirm(`Reset the owner password for ${restaurant.name}? This immediately signs the owner out.`)) return;
    try {
      const response = await superApi(`/restaurants/${restaurant.id}/owner/reset-password`, { method: 'POST' });
      setCredentials({ restaurantName: restaurant.name, ownerUsername: response.ownerUsername, temporaryPassword: response.temporaryOwnerPassword });
      show('Owner password reset. Copy the one-time password now.');
      load();
    } catch (error) { show(error.message, 'error'); }
  };
  const supportProps = { restaurant, onChanged: updated, show, session: supportSession, onSessionChange: setSupportSession };
  return <section className="super-admin-page"><header className="super-admin-page-header"><div><button className="text-button super-back" onClick={onBack}>← All restaurants</button><p className="eyebrow">{restaurant.forgeArcRestaurantId}</p><h1>{restaurant.name}</h1><p className="muted">/{restaurant.slug} · {restaurant.owner?.username ? `Owner @${restaurant.owner.username}` : 'Owner account missing'}</p></div><div className="header-actions"><span className={`status-pill ${statusClass(restaurant.operationalStatus)}`}>{statusLabel(restaurant.operationalStatus)}</span><button className="outline" disabled={refreshing} onClick={() => load()}>{refreshing ? 'Refreshing…' : 'Refresh'}</button></div></header>
    <nav className="super-admin-tabs"><button className={activeTab === 'overview' ? 'active' : ''} onClick={() => setActiveTab('overview')}>Overview</button>{unlockTabs && <><button className={activeTab === 'commercial' ? 'active' : ''} onClick={() => setActiveTab('commercial')}>Commercials & QR</button><button className={activeTab === 'support' ? 'active' : ''} onClick={() => setActiveTab('support')}>Support Mode</button><button className={activeTab === 'audit' ? 'active' : ''} onClick={() => setActiveTab('audit')}>Audit log</button></>}</nav>
    {activeTab === 'overview' && <div className="super-admin-detail-stack"><div className="super-admin-overview-grid"><section className="super-admin-panel"><div className="panel-title"><div><p className="eyebrow">OPERATIONAL ACCESS</p><h2>Restaurant status</h2></div></div><RestaurantStatusForm restaurant={restaurant} onSaved={updated} show={show} /></section><section className="super-admin-panel"><div className="panel-title"><div><p className="eyebrow">ONBOARDING</p><h2>Setup readiness</h2></div><strong>{restaurant.setup.completed}/{restaurant.setup.total}</strong></div><SetupChecklist restaurant={restaurant} onChanged={updated} show={show} readOnly={!inSetup} /><div className="setup-readiness-copy">{inSetup ? <>{restaurant.setup.blockers.length ? <><strong>Blocking activation</strong><ul>{restaurant.setup.blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}</ul></> : <p className="muted">All setup requirements are complete. The restaurant will activate automatically.</p>}</> : <p className="muted">The onboarding checklist is retained as a launch record after activation.</p>}</div></section></div>
      <section className="super-admin-panel"><div className="panel-title"><div><p className="eyebrow">RESTAURANT PROFILE</p><h2>Basic information</h2><p className="muted">This is the single Super Admin location for restaurant contact, GST, billing and opening-hour details. Saving required basics completes the corresponding setup task automatically.</p></div></div><RestaurantBasicsForm restaurant={restaurant} onSaved={updated} show={show} /></section>
      <section className="super-admin-panel owner-account-panel"><div className="panel-title"><div><p className="eyebrow">OWNER ACCOUNT</p><h2>{restaurant.owner?.displayName || 'Not configured'}</h2><p className="muted">{restaurant.owner?.username ? `@${restaurant.owner.username}` : 'No owner login exists'}</p></div><div className="owner-account-state"><span className={`status-pill ${restaurant.owner?.mustChangePassword ? 'due-soon' : 'active'}`}>{restaurant.owner?.mustChangePassword ? 'Password change required' : 'Password active'}</span><button className="outline danger-text" onClick={resetOwnerPassword}>Reset owner password</button></div></div></section>
      {inSetup && <SupportModePanel {...supportProps} setupOnly />}
    </div>}
    {unlockTabs && activeTab === 'commercial' && <CommercialPanel restaurant={restaurant} onSaved={updated} show={show} />}
    {unlockTabs && activeTab === 'support' && <SupportModePanel {...supportProps} />}
    {unlockTabs && activeTab === 'audit' && <section className="super-admin-panel"><div className="panel-title"><div><p className="eyebrow">ACCOUNTABILITY</p><h2>Super Admin audit log</h2></div></div><div className="super-admin-audit-list">{!auditLogs.length ? <p className="muted">No Super Admin actions recorded yet.</p> : auditLogs.map((log) => <article key={log.id}><div><strong>{statusLabel(log.action)}</strong><span>{log.actorName}{log.supportReason ? ` · Support: ${log.supportReason}` : ''}</span></div><time>{new Date(log.createdAt).toLocaleString()}</time></article>)}</div></section>}
    {credentials && <OwnerCredentialsNotice credentials={credentials} onClose={() => setCredentials(null)} />}
  </section>;
}

function RestaurantStatusForm({ restaurant, onSaved, show }) {
  const [busy, setBusy] = useState(false);
  const transition = async (operationalStatus, confirmation) => {
    if (confirmation && !window.confirm(confirmation)) return;
    setBusy(true);
    try {
      const result = await superApi(`/restaurants/${restaurant.id}/status`, { method: 'PUT', body: JSON.stringify({ operationalStatus }) });
      await onSaved(result);
      show(`Restaurant ${statusLabel(operationalStatus).toLowerCase()}.`);
    } catch (error) { show(error.message, 'error'); } finally { setBusy(false); }
  };
  if (restaurant.operationalStatus === 'SETUP_PENDING') return <div className="status-control setup-status-control"><div><span className="status-pill setup-pending">Setup pending</span><p className="form-help">This state is automatic. It changes to Active only after every required setup task, including the owner password change, is complete.</p></div></div>;
  if (restaurant.operationalStatus === 'ACTIVE') return <div className="status-control"><div><span className="status-pill active">Active</span><p className="form-help">A live restaurant cannot return to Setup Pending. Suspend or disable it only when service must be stopped.</p></div><div className="status-action-row"><button className="outline warning-outline" disabled={busy} onClick={() => transition('SUSPENDED', `Suspend ${restaurant.name}? Staff access and new QR orders will stop, but data stays intact.`)}>Suspend restaurant</button><button className="outline danger-outline" disabled={busy} onClick={() => transition('DISABLED', `Disable ${restaurant.name}? This blocks access until you reactivate it.`)}>Disable restaurant</button></div></div>;
  return <div className="status-control"><div><span className={`status-pill ${statusClass(restaurant.operationalStatus)}`}>{statusLabel(restaurant.operationalStatus)}</span><p className="form-help">Reactivate only after the operational or payment issue is resolved. The outlet returns directly to Active, never Setup Pending.</p></div><div><button className="primary" disabled={busy} onClick={() => transition('ACTIVE', `Reactivate ${restaurant.name}? Staff access and eligible QR orders will become available again.`)}>{busy ? 'Saving…' : 'Reactivate restaurant'}</button></div></div>;
}

function RestaurantBasicsForm({ restaurant, onSaved, show, supportSessionId = null }) {
  const initial = () => ({ name: restaurant.name, slug: restaurant.slug, phone: restaurant.phone, address: restaurant.address, gstin: restaurant.gstin, billPrefix: restaurant.billPrefix, openingTime: restaurant.openingTime, closingTime: restaurant.closingTime });
  const [form, setForm] = useState(initial);
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  useEffect(() => { setForm(initial()); setErrors({}); }, [restaurant]);
  const update = (key, value) => { setForm((current) => ({ ...current, [key]: value })); setErrors((current) => ({ ...current, [key]: '' })); };
  const submit = async (event) => {
    event.preventDefault();
    const next = {};
    if (!form.phone.trim()) next.phone = 'Phone is required to complete restaurant basics.';
    if (!form.address.trim()) next.address = 'Address is required to complete restaurant basics.';
    if (form.closingTime <= form.openingTime) next.closingTime = 'Closing time must be after opening time.';
    if (Object.keys(next).length) { setErrors(next); return; }
    setBusy(true);
    try {
      const path = supportSessionId ? `/support/${restaurant.id}/basics` : `/restaurants/${restaurant.id}/basics`;
      const result = await superApi(path, { method: 'PUT', body: JSON.stringify(form), headers: supportSessionId ? { 'X-DirectQR-Support-Session': supportSessionId } : {} });
      await onSaved(result); show('Restaurant basics saved.');
    } catch (error) { setErrors(superAdminFieldErrors(error)); show(error.message, 'error'); } finally { setBusy(false); }
  };
  return <form className="super-admin-form" onSubmit={submit} noValidate><div className="super-admin-form-grid"><label>Restaurant name<input value={form.name} aria-invalid={Boolean(errors.name)} onChange={(event) => update('name', event.target.value)} required /><FieldError message={errors.name} /></label><label>DirectQR slug<input value={form.slug} aria-invalid={Boolean(errors.slug)} onChange={(event) => update('slug', event.target.value.toLowerCase())} required /><FieldError message={errors.slug} /></label><label>Phone<input value={form.phone} aria-invalid={Boolean(errors.phone)} onChange={(event) => update('phone', event.target.value)} required /><FieldError message={errors.phone} /></label><label>Bill prefix<input value={form.billPrefix} aria-invalid={Boolean(errors.billPrefix)} onChange={(event) => update('billPrefix', event.target.value.toUpperCase())} required /><FieldError message={errors.billPrefix} /></label><label>Opening time<input type="time" value={form.openingTime} onChange={(event) => update('openingTime', event.target.value)} required /></label><label>Closing time<input type="time" value={form.closingTime} aria-invalid={Boolean(errors.closingTime)} onChange={(event) => update('closingTime', event.target.value)} required /><FieldError message={errors.closingTime} /></label><label>GSTIN <small>Optional if the outlet is not GST registered.</small><input value={form.gstin} aria-invalid={Boolean(errors.gstin)} onChange={(event) => update('gstin', event.target.value.toUpperCase())} /><FieldError message={errors.gstin} /></label><label className="full">Address<textarea value={form.address} aria-invalid={Boolean(errors.address)} onChange={(event) => update('address', event.target.value)} required /><FieldError message={errors.address} /></label></div><div className="panel-actions"><button className="primary" disabled={busy}>{busy ? 'Saving…' : 'Save restaurant basics'}</button></div></form>;
}

function SetupChecklist({ restaurant, onChanged, show, supportSessionId = null, readOnly = false }) {
  const [busyKey, setBusyKey] = useState('');
  const setupPending = restaurant.operationalStatus === 'SETUP_PENDING';
  const canEdit = Boolean(supportSessionId) && !readOnly && setupPending;
  const toggle = async (task) => {
    if (!canEdit || task.mode === 'AUTOMATIC') return;
    setBusyKey(task.key);
    try {
      const result = await superApi(`/support/${restaurant.id}/setup-tasks/${task.key}`, { method: 'PUT', body: JSON.stringify({ isCompleted: !task.isCompleted }), headers: { 'X-DirectQR-Support-Session': supportSessionId } });
      await onChanged(result); show(`${task.label} updated.`);
    } catch (error) { show(error.message, 'error'); } finally { setBusyKey(''); }
  };
  return <div className="setup-task-list">{restaurant.setup.tasks.map((task) => <label key={task.key} className={`setup-task ${task.isCompleted ? 'done' : ''} ${task.mode === 'AUTOMATIC' ? 'automatic' : ''}`}><input type="checkbox" checked={task.isCompleted} disabled={!canEdit || task.mode === 'AUTOMATIC' || busyKey === task.key} onChange={() => toggle(task)} /><span>{task.label}</span><small>{task.mode === 'AUTOMATIC' ? (task.key === 'OWNER_PASSWORD_CHANGED' ? 'Owner action' : 'Automatic') : canEdit ? 'Manual confirmation' : 'Support confirmation'}</small></label>)}</div>;
}

function CommercialPanel({ restaurant, onSaved, show }) {
  const commercialForm = (source = restaurant) => {
    const c = source.commercial;
    return {
      basePaymentStatus: c.basePaymentStatus,
      baseLicenseStartDate: c.baseLicenseStartDate || '',
      baseLicenseEndDate: c.baseLicenseEndDate || '',
      supportPaymentStatus: c.supportPaymentStatus,
      supportStartDate: c.supportStartDate || '',
      supportLastPaymentDate: c.supportLastPaymentDate || '',
      supportNextPaymentDue: c.supportNextPaymentDue || '',
    };
  };
  const [form, setForm] = useState(commercialForm());
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  useEffect(() => { setForm(commercialForm(restaurant)); setErrors({}); }, [restaurant]);

  const patch = (changes) => {
    setForm((current) => ({ ...current, ...changes }));
    setErrors((current) => Object.fromEntries(Object.entries(current).filter(([key]) => !Object.keys(changes).includes(key))));
  };
  const baseLocked = Boolean(restaurant.commercial.baseIsCurrent);
  const supportLocked = Boolean(restaurant.commercial.supportIsCurrent);
  const setBaseStatus = (basePaymentStatus) => setForm((current) => {
    if (basePaymentStatus === 'NOT_PAID') return { ...current, basePaymentStatus, baseLicenseStartDate: '', baseLicenseEndDate: '' };
    return { ...current, basePaymentStatus, baseLicenseEndDate: basePaymentStatus === 'PAID' && current.baseLicenseStartDate ? addCalendarYearsInput(current.baseLicenseStartDate) : current.baseLicenseEndDate };
  });
  const setBaseStart = (baseLicenseStartDate) => setForm((current) => ({
    ...current,
    baseLicenseStartDate,
    baseLicenseEndDate: current.basePaymentStatus === 'PAID' && baseLicenseStartDate ? addCalendarYearsInput(baseLicenseStartDate) : current.baseLicenseEndDate,
  }));
  const setSupportStatus = (supportPaymentStatus) => setForm((current) => {
    if (supportPaymentStatus === 'NOT_STARTED') return { ...current, supportPaymentStatus, supportStartDate: '', supportLastPaymentDate: '', supportNextPaymentDue: '' };
    const anchor = current.supportLastPaymentDate || current.supportStartDate;
    return { ...current, supportPaymentStatus, supportStartDate: current.supportStartDate || anchor, supportLastPaymentDate: anchor, supportNextPaymentDue: anchor ? addCalendarMonthsInput(anchor) : '' };
  });
  const setSupportStart = (supportStartDate) => setForm((current) => {
    const lastPayment = current.supportLastPaymentDate || (current.supportPaymentStatus === 'PAID' ? supportStartDate : '');
    return { ...current, supportStartDate, supportLastPaymentDate: lastPayment, supportNextPaymentDue: lastPayment ? addCalendarMonthsInput(lastPayment) : '' };
  });
  const setSupportLastPayment = (supportLastPaymentDate) => setForm((current) => ({ ...current, supportStartDate: current.supportStartDate || supportLastPaymentDate, supportLastPaymentDate, supportNextPaymentDue: supportLastPaymentDate ? addCalendarMonthsInput(supportLastPaymentDate) : '' }));

  const submit = async (event) => {
    event.preventDefault();
    const next = {};
    if (form.basePaymentStatus === 'PAID' && !form.baseLicenseStartDate) next.baseLicenseStartDate = 'Select the DirectQR licence start date.';
    if (form.supportPaymentStatus === 'PAID' && !(form.supportLastPaymentDate || form.supportStartDate)) next.supportLastPaymentDate = 'Enter the technical-support payment date.';
    if (Object.keys(next).length) { setErrors(next); return; }
    setBusy(true);
    try {
      // Compatibility fields keep the API payload explicit while DirectQR itself
      // has no separate QR add-on entitlement.
      const result = await superApi(`/restaurants/${restaurant.id}/commercial`, { method: 'PUT', body: JSON.stringify(nullDates({ ...form, directQrOrdering: true, qrOrderingPaymentStatus: 'NOT_PURCHASED', qrOrderingStartDate: null, qrOrderingEndDate: null })) });
      await onSaved(result);
      show('DirectQR licence and support records saved.');
    } catch (error) {
      setErrors(superAdminFieldErrors(error));
      show(error.message, 'error');
    } finally { setBusy(false); }
  };

  return <section className="super-admin-panel">
    <div className="panel-title"><div><p className="eyebrow">COMMERCIAL CONTROLS</p><h2>DirectQR licence and support</h2><p className="muted">The annual DirectQR licence controls new public QR orders. Commercial expiry never deletes data or automatically suspends the restaurant.</p></div></div>
    <form className="super-admin-form commercial-form" onSubmit={submit} noValidate>
      <section>
        <h3>DirectQR Annual Licence <span>₹3,000 / year</span></h3>
        <p className="form-help">Mark the licence paid and select the start date. The end date is set to the same calendar date next year and remains locked while current.</p>
        <div className="super-admin-form-grid">
          <StatusSelect label="Licence status" value={form.basePaymentStatus} onChange={setBaseStatus} disabled={baseLocked} help={baseLocked ? 'Locked while this paid licence is current.' : ''} options={['NOT_PAID', 'PAID', 'EXPIRED']} />
          <label>Licence start<input type="date" value={form.baseLicenseStartDate} disabled={baseLocked} aria-invalid={Boolean(errors.baseLicenseStartDate)} onChange={(event) => setBaseStart(event.target.value)} /><FieldError message={errors.baseLicenseStartDate} /></label>
          <label>Licence end <small>Calculated as start date + 1 year.</small><input type="date" value={form.baseLicenseEndDate} readOnly aria-readonly="true" /><FieldError message={errors.baseLicenseEndDate} /></label>
        </div>
      </section>
      <section>
        <h3>Technical Support <span>₹299 / month</span></h3>
        <p className="form-help">Support becomes Due on its payment date and Overdue seven calendar days later. Date fields reopen when renewal is due.</p>
        <div className="super-admin-form-grid">
          <StatusSelect label="Support status" value={form.supportPaymentStatus} onChange={setSupportStatus} disabled={supportLocked} help={supportLocked ? 'Locked until the next support payment due date.' : ''} options={['NOT_STARTED', 'PAID', 'DUE', 'OVERDUE']} />
          <label>Support start<input type="date" value={form.supportStartDate} disabled={supportLocked} aria-invalid={Boolean(errors.supportStartDate)} onChange={(event) => setSupportStart(event.target.value)} /><FieldError message={errors.supportStartDate} /></label>
          <label>Last payment<input type="date" value={form.supportLastPaymentDate} disabled={supportLocked} aria-invalid={Boolean(errors.supportLastPaymentDate)} onChange={(event) => setSupportLastPayment(event.target.value)} /><FieldError message={errors.supportLastPaymentDate} /></label>
          <label>Next payment due <small>Calculated one calendar month after last payment.</small><input type="date" value={form.supportNextPaymentDue} readOnly aria-readonly="true" /><FieldError message={errors.supportNextPaymentDue} /></label>
        </div>
      </section>
      <div className="panel-actions"><button className="primary" disabled={busy}>{busy ? 'Saving…' : 'Save commercial records'}</button></div>
    </form>
  </section>;
}
function SupportModePanel({ restaurant, onChanged, show, setupOnly = false, session, onSessionChange }) {
  const [scopes, setScopes] = useState(setupOnly ? ['SETUP', 'MENU'] : ['MENU']);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const start = async (event) => {
    event.preventDefault();
    setBusy(true);
    try {
      const selectedScopes = setupOnly ? ['SETUP', 'MENU'] : scopes;
      const data = await superApi(`/restaurants/${restaurant.id}/support-sessions`, { method: 'POST', body: JSON.stringify({ scopes: selectedScopes, reason }) });
      onSessionChange(data.supportSession);
      show('Support Mode started. Every change will be audited.');
    } catch (error) { show(error.message, 'error'); } finally { setBusy(false); }
  };
  const close = async () => {
    if (!session) return;
    try {
      await superApi(`/support-sessions/${session.id}/close`, { method: 'POST' });
      onSessionChange(null);
      show('Support Mode closed.');
      onChanged();
    } catch (error) { show(error.message, 'error'); }
  };
  const toggleScope = (scope) => setScopes((current) => current.includes(scope) ? current.filter((item) => item !== scope) : [...current, scope]);
  if (!session) return <section className="super-admin-panel support-entry"><div className="panel-title"><div><p className="eyebrow">CONTROLLED ACCESS</p><h2>{setupOnly ? 'Open Setup Support' : 'Enter Support Mode'}</h2><p className="muted">{setupOnly ? 'Configure the initial menu, table set, and manual go-live confirmations. Restaurant contact, GST, billing and timing details remain in Overview so there is only one source of truth. Every support session is audited and expires after two hours.' : 'Support Mode is time-limited to two hours. Select only the scope required, state why you are accessing client configuration, and all changes remain traceable.'}</p></div></div><form className="super-admin-form" onSubmit={start}>{setupOnly ? <p className="support-locked-scope">Menu and setup scopes are enabled for this onboarding session.</p> : <div className="support-scope-options"><label><input type="checkbox" checked={scopes.includes('MENU')} onChange={() => toggleScope('MENU')} /> Menu and categories</label><label><input type="checkbox" checked={scopes.includes('SETUP')} onChange={() => toggleScope('SETUP')} /> Tables and setup confirmations</label></div>}<label>Support reason<textarea value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Example: initial restaurant onboarding and menu configuration" minLength="3" required /></label><div className="panel-actions"><button className="primary" disabled={busy || (!setupOnly && !scopes.length)}>{busy ? 'Entering…' : setupOnly ? 'Open Setup Support' : 'Enter Support Mode'}</button></div></form></section>;
  return <div className="super-admin-detail-stack"><section className="support-active-banner"><div><p className="eyebrow">DIRECTQR SUPPORT MODE</p><h2>Editing {restaurant.name}</h2><p>{session.reason} · Expires {new Date(session.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</p></div><button className="outline danger-text" onClick={close}>Close Support Mode</button></section>{session.scopes.includes('SETUP') && <><section className="super-admin-panel"><div className="panel-title"><div><p className="eyebrow">SETUP SCOPE</p><h2>Table configuration</h2></div></div><SupportTableSetup restaurant={restaurant} supportSessionId={session.id} onChanged={onChanged} show={show} /></section><section className="super-admin-panel"><div className="panel-title"><div><p className="eyebrow">SETUP SCOPE</p><h2>Onboarding checklist</h2><p className="muted">Manual confirmations are kept here. Automatic items update from actual setup data.</p></div></div><SetupChecklist restaurant={restaurant} onChanged={onChanged} show={show} supportSessionId={session.id} /></section></>}{session.scopes.includes('MENU') && <SupportMenuEditor restaurant={restaurant} supportSessionId={session.id} show={show} onChanged={onChanged} />}</div>;
}

function SupportTableSetup({ restaurant, supportSessionId, onChanged, show }) {
  const [tables, setTables] = useState([]);
  const [count, setCount] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const headers = { 'X-DirectQR-Support-Session': supportSessionId };
  const load = useCallback(async () => { setLoading(true); try { const data = await superApi(`/support/${restaurant.id}/tables`, { headers }); setTables(data.tables || []); } catch (error) { show(error.message, 'error'); } finally { setLoading(false); } }, [restaurant.id, supportSessionId, show]);
  useEffect(() => { load(); }, [load]);
  const add = async (event) => { event.preventDefault(); const numericCount = Number(count); if (!Number.isInteger(numericCount) || numericCount < 1 || numericCount > 100) { show('Enter a whole number from 1 to 100.', 'error'); return; } setBusy(true); try { await superApi(`/support/${restaurant.id}/tables/bulk`, { method: 'POST', headers, body: JSON.stringify({ count: numericCount }) }); setCount(''); await load(); await onChanged(); show(`${numericCount} table${numericCount === 1 ? '' : 's'} created.`); } catch (error) { show(error.message, 'error'); } finally { setBusy(false); } };
  const activeTables = tables.filter((table) => table.isActive);
  return <div className="support-table-setup"><p className="muted">Create the initial numbered table set. Live table edits remain in the restaurant POS after activation.</p><form className="compact-support-form support-table-form" onSubmit={add}><label>Number of tables<input type="number" min="1" max="100" step="1" value={count} onChange={(event) => setCount(event.target.value)} placeholder="Example: 12" required /></label><button className="outline" disabled={busy || restaurant.operationalStatus !== 'SETUP_PENDING'}>{busy ? 'Creating…' : 'Create numbered tables'}</button></form>{loading ? <p className="muted">Loading tables…</p> : <div className="support-table-chips">{activeTables.map((table) => <span key={table.id}>{table.name}</span>)}{!activeTables.length && <small>No active tables yet.</small>}</div>}</div>;
}

function SupportMenuEditor({ restaurant, supportSessionId, show, onChanged = async () => {} }) {
  const [menu, setMenu] = useState({ categories: [], items: [] });
  const [loading, setLoading] = useState(true);
  const [categoryName, setCategoryName] = useState('');
  const [itemForm, setItemForm] = useState({ categoryId: '', name: '', description: '', price: '', gstRate: '5', availability: 'AVAILABLE', addonGroups: [] });
  const [editingId, setEditingId] = useState(null);
  const [busy, setBusy] = useState(false);
  const headers = { 'X-DirectQR-Support-Session': supportSessionId };
  const load = useCallback(async () => { setLoading(true); try { const data = await superApi(`/support/${restaurant.id}/menu`, { headers }); setMenu(data); setItemForm((current) => ({ ...current, categoryId: current.categoryId || data.categories.find((category) => category.isActive)?.id || '' })); } catch (error) { show(error.message, 'error'); } finally { setLoading(false); } }, [restaurant.id, supportSessionId, show]);
  useEffect(() => { load(); }, [load]);
  const addCategory = async (event) => { event.preventDefault(); if (!categoryName.trim()) return; setBusy(true); try { await superApi(`/support/${restaurant.id}/categories`, { method: 'POST', headers, body: JSON.stringify({ name: categoryName, position: menu.categories.length, foodType: 'VEG' }) }); setCategoryName(''); await load(); await onChanged(); show('Category added.'); } catch (error) { show(error.message, 'error'); } finally { setBusy(false); } };
  const saveItem = async (event) => { event.preventDefault(); setBusy(true); try { const payload = { ...itemForm, price: Number(itemForm.price), gstRate: Number(itemForm.gstRate), addonGroups: itemForm.addonGroups || [] }; const path = editingId ? `/support/${restaurant.id}/menu-items/${editingId}` : `/support/${restaurant.id}/menu-items`; await superApi(path, { method: editingId ? 'PUT' : 'POST', headers, body: JSON.stringify(payload) }); setEditingId(null); setItemForm({ categoryId: menu.categories.find((category) => category.isActive)?.id || '', name: '', description: '', price: '', gstRate: '5', availability: 'AVAILABLE', addonGroups: [] }); await load(); await onChanged(); show(editingId ? 'Menu item updated.' : 'Menu item added.'); } catch (error) { show(error.message, 'error'); } finally { setBusy(false); } };
  const editItem = (item) => { setEditingId(item.id); setItemForm({ categoryId: item.categoryId, name: item.name, description: item.description || '', price: String(item.price), gstRate: String(item.gstRate), availability: item.availability || 'AVAILABLE', addonGroups: item.addonGroups || [] }); };
  const deactivateItem = async (item) => { if (!window.confirm(`Deactivate ${item.name}?`)) return; try { await superApi(`/support/${restaurant.id}/menu-items/${item.id}`, { method: 'DELETE', headers }); await load(); await onChanged(); show('Menu item deactivated.'); } catch (error) { show(error.message, 'error'); } };
  const deleteCategory = async (category) => { if (!window.confirm(`Delete ${category.name}? Categories with active items cannot be deleted.`)) return; try { await superApi(`/support/${restaurant.id}/categories/${category.id}`, { method: 'DELETE', headers }); await load(); await onChanged(); show('Category deleted.'); } catch (error) { show(error.message, 'error'); } };
  const activeCategories = menu.categories.filter((category) => category.isActive);
  return <section className="super-admin-panel support-menu-panel"><div className="panel-title"><div><p className="eyebrow">MENU SCOPE</p><h2>Menu & categories</h2><p className="muted">Use this controlled editor for client-assisted menu changes. Existing add-ons are preserved when editing an item here.</p></div></div>{loading ? <div className="empty">Loading client menu…</div> : <div className="support-menu-layout"><div><form className="compact-support-form" onSubmit={addCategory}><h3>Add category</h3><label>Category name<input value={categoryName} onChange={(event) => setCategoryName(event.target.value)} required /></label><button className="outline" disabled={busy}>Add category</button></form><div className="support-category-list">{menu.categories.map((category) => <div key={category.id}><span>{category.name} {!category.isActive && <small>Inactive</small>}</span>{category.isActive && <button type="button" className="icon-delete-button" title={`Delete ${category.name}`} onClick={() => deleteCategory(category)}><Icon name="trash" size={15} /></button>}</div>)}</div></div><form className="super-admin-form compact-support-form" onSubmit={saveItem}><h3>{editingId ? 'Edit menu item' : 'Add menu item'}</h3><div className="super-admin-form-grid"><label>Category<select value={itemForm.categoryId} onChange={(event) => setItemForm((current) => ({ ...current, categoryId: event.target.value }))} required><option value="">Choose category</option>{activeCategories.map((category) => <option value={category.id} key={category.id}>{category.name}</option>)}</select></label><label>Item name<input value={itemForm.name} onChange={(event) => setItemForm((current) => ({ ...current, name: event.target.value }))} required /></label><label>Price<input type="number" min="0" step="0.01" value={itemForm.price} onChange={(event) => setItemForm((current) => ({ ...current, price: event.target.value }))} required /></label><label>GST rate<input type="number" min="0" max="100" step="0.01" value={itemForm.gstRate} onChange={(event) => setItemForm((current) => ({ ...current, gstRate: event.target.value }))} required /></label><label>Availability<select value={itemForm.availability} onChange={(event) => setItemForm((current) => ({ ...current, availability: event.target.value }))}><option value="AVAILABLE">Available</option><option value="OUT_OF_STOCK">Out of stock</option></select></label><label className="full">Description<textarea value={itemForm.description} onChange={(event) => setItemForm((current) => ({ ...current, description: event.target.value }))} /></label></div><div className="panel-actions">{editingId && <button type="button" className="outline" onClick={() => { setEditingId(null); setItemForm({ categoryId: activeCategories[0]?.id || '', name: '', description: '', price: '', gstRate: '5', availability: 'AVAILABLE', addonGroups: [] }); }}>Cancel edit</button>}<button className="primary" disabled={busy || !activeCategories.length}>{busy ? 'Saving…' : editingId ? 'Save item' : 'Add item'}</button></div></form></div>}<div className="support-menu-items">{menu.items.map((item) => <article key={item.id} className={!item.isActive ? 'inactive' : ''}><div><strong>{item.name}</strong><span>{activeCategories.find((category) => category.id === item.categoryId)?.name || 'Archived category'} · {rupees(item.price)} · GST {item.gstRate}%</span>{item.description && <p>{item.description}</p>}{item.addonGroups?.length ? <small>{item.addonGroups.length} add-on group{item.addonGroups.length === 1 ? '' : 's'} preserved</small> : null}</div><div><button className="text-button" onClick={() => editItem(item)}>Edit</button>{item.isActive && <button className="text-button danger-text" onClick={() => deactivateItem(item)}>Deactivate</button>}</div></article>)}{!menu.items.length && <div className="empty">No menu items yet.</div>}</div></section>;
}

function PosShell({ session, onSessionChange, onLogout, toast, show }) {
  const isAdmin = session.role === "OWNER";
  const permissions = session.permissions || {};
  const can = (key) => isAdmin || Boolean(permissions[key]);
  const [view, setView] = useState(isAdmin ? "dashboard" : "tables");
  const [activeTable, setActiveTable] = useState(null);
  const [orderDirty, setOrderDirty] = useState(false);
  const [quickAction, setQuickAction] = useState(null);
  const [mobileMenu, setMobileMenu] = useState(null);
  const { confirm, requestForm, element: actionDialog } = useActionDialog();
  const status = outletStatus(session);
  const directQrOrdering = Boolean(session.features?.directQrOrdering);
  const [qrEventVersion, setQrEventVersion] = useState(0);
  const [qrSoundEnabled, setQrSoundEnabled] = useState(false);
  const qrAlarmTimerRef = useRef(null);
  const qrAlarmTimeoutsRef = useRef(new Set());
  const qrAlarmOscillatorsRef = useRef(new Set());
  const qrAlarmActiveRef = useRef(false);
  const [pendingQrRequestCount, setPendingQrRequestCount] = useState(0);
  const [pushState, setPushState] = useState({ label: 'Enable mobile alerts', supported: true });
  const enablePushNotifications = useCallback(async () => {
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
      setPushState({ label: 'Alerts unsupported', supported: false });
      show('This browser does not support DirectQR notification-bar alerts. Keep the console open and enable order sound as the fallback.', 'error');
      return;
    }
    try {
      const config = await api('/notifications/config');
      if (!config.configured || !config.publicKey) {
        setPushState({ label: 'Alerts not configured', supported: false });
        show('Push alerts are not configured on this DirectQR server yet. Add the VAPID keys before go-live.', 'error');
        return;
      }
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        setPushState({ label: 'Notifications blocked', supported: false });
        show('Notification permission was not granted. Enable it in this browser/device settings to receive background QR alerts.', 'error');
        return;
      }
      const applicationServerKey = urlBase64ToUint8Array(config.publicKey);
      if (applicationServerKey.byteLength !== 65) {
        throw new Error('The DirectQR notification key is invalid. Regenerate the VAPID key pair and update both Render variables.');
      }
      const registration = await navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' });
      await navigator.serviceWorker.ready;
      await registration.update().catch(() => undefined);
      let subscription = await registration.pushManager.getSubscription();
      const existingKey = subscription?.options?.applicationServerKey;
      if (subscription && existingKey) {
        const currentKey = new Uint8Array(existingKey);
        const keyChanged = currentKey.length !== applicationServerKey.length || currentKey.some((value, index) => value !== applicationServerKey[index]);
        if (keyChanged) {
          await subscription.unsubscribe();
          subscription = null;
        }
      }
      if (!subscription) {
        subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey,
        });
      }
      await api('/notifications/subscribe', { method: 'POST', body: JSON.stringify(subscription.toJSON()) });
      setPushState({ label: 'Mobile alerts on', supported: true });
      show('DirectQR mobile alerts are enabled for this device. Use Test alert in Settings before go-live.');
    } catch (error) {
      setPushState({ label: 'Enable mobile alerts', supported: true });
      const message = /push service error/i.test(String(error?.message || ''))
        ? 'Browser push registration failed. In Brave, allow notifications and Push Messaging for this site, then retry. If the browser blocks its push service, keep the DirectQR console open for looping sound and live alerts.'
        : (error.message || 'Could not enable mobile notifications.');
      show(message, 'error');
    }
  }, [show]);

  const clearScheduledQrAlarm = useCallback(() => {
    for (const timeoutId of qrAlarmTimeoutsRef.current) window.clearTimeout(timeoutId);
    qrAlarmTimeoutsRef.current.clear();
    for (const oscillator of qrAlarmOscillatorsRef.current) {
      try { oscillator.stop(); } catch { /* oscillator may have ended already */ }
      try { oscillator.disconnect(); } catch { /* no-op */ }
    }
    qrAlarmOscillatorsRef.current.clear();
  }, []);
  const ringQrAlarm = useCallback(() => {
    const context = window.__directqrAudioContext;
    if (!qrAlarmActiveRef.current || !context || context.state !== 'running') return;
    [[0, 920], [360, 700], [720, 920], [1080, 700], [1440, 1040], [1860, 820], [2250, 1040]].forEach(([delay, frequency]) => {
      const timeoutId = window.setTimeout(() => {
        qrAlarmTimeoutsRef.current.delete(timeoutId);
        if (!qrAlarmActiveRef.current || context.state !== 'running') return;
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        qrAlarmOscillatorsRef.current.add(oscillator);
        oscillator.type = 'sine';
        oscillator.frequency.value = frequency;
        gain.gain.setValueAtTime(0.0001, context.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.18, context.currentTime + 0.025);
        gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.34);
        oscillator.connect(gain).connect(context.destination);
        oscillator.onended = () => {
          qrAlarmOscillatorsRef.current.delete(oscillator);
          try { oscillator.disconnect(); } catch { /* no-op */ }
        };
        oscillator.start();
        oscillator.stop(context.currentTime + 0.36);
      }, delay);
      qrAlarmTimeoutsRef.current.add(timeoutId);
    });
  }, []);
  const stopQrAlarm = useCallback(() => {
    qrAlarmActiveRef.current = false;
    if (qrAlarmTimerRef.current) {
      window.clearInterval(qrAlarmTimerRef.current);
      qrAlarmTimerRef.current = null;
    }
    clearScheduledQrAlarm();
  }, [clearScheduledQrAlarm]);
  const startQrAlarm = useCallback(() => {
    const context = window.__directqrAudioContext;
    if (!context || context.state !== 'running' || qrAlarmActiveRef.current) return;
    qrAlarmActiveRef.current = true;
    ringQrAlarm();
    qrAlarmTimerRef.current = window.setInterval(ringQrAlarm, 6400);
  }, [ringQrAlarm]);
  const applyPendingQrRequestCount = useCallback((count) => {
    const pending = Math.max(0, Number(count || 0));
    setPendingQrRequestCount(pending);
    if (!directQrOrdering || pending === 0) {
      stopQrAlarm();
      return;
    }
    startQrAlarm();
  }, [directQrOrdering, startQrAlarm, stopQrAlarm]);
  const reconcileQrAlarm = useCallback(async () => {
    if (!directQrOrdering) { applyPendingQrRequestCount(0); return; }
    try {
      const result = await api('/qr-orders');
      applyPendingQrRequestCount(Array.isArray(result.orders) ? result.orders.length : 0);
    } catch {
      // Do not stop an active alert merely because a refresh temporarily failed.
    }
  }, [applyPendingQrRequestCount, directQrOrdering]);
  const enableQrSound = useCallback(async () => {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) {
      show('This browser does not support order sound alerts.', 'error');
      return;
    }
    const context = window.__directqrAudioContext || new AudioContextClass();
    window.__directqrAudioContext = context;
    await context.resume();
    setQrSoundEnabled(true);
    await reconcileQrAlarm();
    if (pendingQrRequestCount > 0) startQrAlarm();
    show('QR order sound is enabled. It stops immediately when the pending queue is cleared.');
  }, [pendingQrRequestCount, reconcileQrAlarm, show, startQrAlarm]);
  useEffect(() => {
    if (!directQrOrdering) { stopQrAlarm(); return void 0; }
    const stream = new EventSource('/api/events/stream');
    const onNewQrOrder = (event) => {
      const data = JSON.parse(event.data || '{}');
      setQrEventVersion((current) => current + 1);
      startQrAlarm();
      show(`New QR order received${data.tableName ? ` for ${data.tableName}` : ''}.`, 'success');
    };
    stream.addEventListener('qr-order:new', onNewQrOrder);
    return () => { stream.close(); stopQrAlarm(); };
  }, [directQrOrdering, startQrAlarm, stopQrAlarm, show]);


  const desktopNavigation = [
    ...(isAdmin ? [["dashboard", "Owner dashboard", "dashboard"]] : []),
    ["tables", "Live QR orders", "tables"],
    ["kot", "KOT view", "printer"],
    ...(can("view_reports") ? [["reports", "Reports", "receipt"]] : []),
    ["menu", "Menu", "menu"],
    ...(isAdmin ? [["settings", "Settings", "settings"]] : [])
  ];
  const canVisit = (next) => ({
    dashboard: isAdmin,
    tables: can("view_tables"),
    kot: can("view_tables"),
    menu: true,
    reports: can("view_reports"),
    settings: isAdmin
  })[next] ?? false;

  const goTo = async (nextView) => {
    if (!canVisit(nextView)) {
      show("You do not have permission for this screen.", "error");
      return false;
    }
    if (view === "order" && nextView !== "order" && orderDirty) {
      const accepted = await confirm({
        title: "Discard unsaved changes?",
        message: "The current order has changes that are not saved. They will be lost if you leave this screen.",
        confirmLabel: "Discard changes",
        tone: "danger"
      });
      if (!accepted) return false;
    }
    setView(nextView);
    setMobileMenu(null);
    if (nextView !== "order") {
      setActiveTable(null);
      setOrderDirty(false);
      setQuickAction(null);
    }
    return true;
  };

  const requestLogout = async () => {
    setMobileMenu(null);
    const accepted = await confirm({
      title: "Log out of DirectQR?",
      message: "You will need to sign in again to continue using this DirectQR terminal.",
      confirmLabel: "Log out",
      tone: "danger"
    });
    if (!accepted) return;
    try {
      await onLogout();
    } catch (error) {
      show(error.message, "error");
    }
  };

  const openTable = (table, action = null) => {
    setActiveTable(table);
    setOrderDirty(false);
    setQuickAction(action);
    setView("order");
    setMobileMenu(null);
  };

  const mobileBottom = isAdmin
    ? [["dashboard", "dashboard", "Dashboard"], ["tables", "tables", "Tables"], ["reports", "receipt", "Reports"], ["more", "more", "More"]]
    : [["tables", "tables", "Tables"], ["kot", "receipt", "KOT"], ["menu", "menu", "Menu"], ["more", "more", "More"]];
  const moreItems = isAdmin ? [["menu", "Menu", "menu"], ["kot", "KOT view", "receipt"]] : [["reports", "Reports", "receipt"]];
  const topPanel = isAdmin ? "settings" : "profile";
  const toggleTopPanel = () => setMobileMenu((current) => current === topPanel ? null : topPanel);

  const selectMobile = (item) => {
    if (item === "logout") return requestLogout();
    if (item === "profile") return setMobileMenu((current) => current === "profile" ? null : "profile");
    return goTo(item);
  };

  return <div className="app-shell forgearc-console" style={{ "--accent": "#147BFF", "--restaurant-accent": session.themeColor || "#147BFF" }}>
    <aside className="sidebar desktop-sidebar">
      <div className="sidebar-brand"><ForgeArcLogo className="sidebar-logo" /><div><strong>DirectQR</strong><span>QR Order Console</span></div></div>
      <div className="desktop-outlet"><strong>{session.restaurantName}</strong><span className={`outlet-status ${status.toLowerCase()}`}>{status}</span></div>
      <nav className="desktop-nav" aria-label="Primary navigation">{desktopNavigation.map(([key, label, icon]) => <button key={key} type="button" title={label} className={view === key ? "nav-active" : ""} onClick={() => goTo(key)}><span className="desktop-nav-icon"><Icon name={icon} size={18} strokeWidth={2} /></span><span>{label}</span></button>)}</nav>
      <div className="sidebar-bottom"><div className="account"><strong>{session.displayName}</strong><span>{roleLabel(session.role)}</span></div><button className="ghost light" onClick={requestLogout}>Log out</button></div>
    </aside>

    <header className="mobile-app-top">
      <div className="mobile-brand"><ForgeArcLogo className="mobile-logo" /><div><strong>{session.restaurantName}</strong><span className={`outlet-status ${status.toLowerCase()}`}>{status}</span></div></div>
      <button className={`top-icon-button ${mobileMenu === topPanel ? "active" : ""}`} aria-label={isAdmin ? "Toggle settings menu" : "Toggle profile menu"} aria-expanded={mobileMenu === topPanel} onClick={toggleTopPanel}>{isAdmin ? <Icon name="settings" /> : <Icon name="user" />}</button>
      {mobileMenu === "settings" && <div className="mobile-top-popover"><button onClick={() => selectMobile("settings")}><Icon name="settings" size={16} />Settings</button><button className="danger-text" onClick={() => selectMobile("logout")}><Icon name="close" size={16} />Log out</button></div>}
      {mobileMenu === "profile" && <div className="mobile-top-popover profile-popover"><strong>{session.displayName}</strong><span>{roleLabel(session.role)}</span><button className="danger-text" onClick={() => selectMobile("logout")}><Icon name="close" size={16} />Log out</button></div>}
    </header>

    <main className="main-panel">
      {view === "dashboard" && isAdmin && <OwnerDashboard show={show} timezone={session.timezone || "Asia/Kolkata"} onOpenReports={() => goTo("reports")} />}
      {view === "tables" && <DirectQRTableView onOpen={openTable} onOpenKot={() => goTo("kot")} show={show} confirm={confirm} canManageTables={can("manage_tables")} permissions={permissions} isAdmin={isAdmin} qrEventVersion={qrEventVersion} qrSoundEnabled={qrSoundEnabled} onEnableQrSound={enableQrSound} onEnableNotifications={enablePushNotifications} notificationLabel={pushState.label} onPendingQrOrdersChange={applyPendingQrRequestCount} onQrOrdersChanged={reconcileQrAlarm} />}
      {view === "kot" && <KotView onOpen={openTable} onOpenTables={() => goTo("tables")} show={show} />}
      {view === "order" && <OrderView table={activeTable} quickAction={quickAction} onQuickActionHandled={() => setQuickAction(null)} permissions={permissions} isAdmin={isAdmin} canVoid={can("void_orders")} confirm={confirm} requestForm={requestForm} onDirtyChange={setOrderDirty} onBack={() => {
        setActiveTable(null);
        setOrderDirty(false);
        setQuickAction(null);
        setView("tables");
      }} show={show} />}
      {view === "reports" && can("view_reports") && <ReportsView show={show} timezone={session.timezone || "Asia/Kolkata"} restaurantName={session.restaurantName} requestForm={requestForm} canReprint={can("reprint_bill")} canCustomerDetails={can("view_customer_details")} />}
      {view === "settings" && isAdmin && <SettingsView session={session} onSessionChange={onSessionChange} show={show} confirm={confirm} requestForm={requestForm} onEnableNotifications={enablePushNotifications} notificationLabel={pushState.label} />}
      {view === "menu" && <MenuView show={show} canManage={can("edit_menu")} confirm={confirm} />}
    </main>

    <nav className="mobile-bottom-nav" aria-label="Primary navigation">
      {mobileBottom.map(([key, icon, label]) => <button key={key} className={view === key || key === "more" && mobileMenu === "more" ? "active" : ""} onClick={() => key === "more" ? setMobileMenu((current) => current === "more" ? null : "more") : goTo(key)}><Icon name={icon} size={18} /><small>{label}</small></button>)}
    </nav>
    {mobileMenu === "more" && <div className="mobile-more-sheet"><div className="mobile-more-handle" />{moreItems.map(([key, label, icon]) => <button key={key} onClick={() => selectMobile(key)}><Icon name={icon} size={17} />{label}</button>)}</div>}
    {toast && <div className={`toast ${toast.type}`} role="status">{toast.message}</div>}
    {actionDialog}
  </div>;
}

function OwnerDashboard({ show, timezone, onOpenReports }) {
  const [date, setDate] = useState(indiaToday());
  const [dashboard, setDashboard] = useState(null);
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      setDashboard(await api(`/dashboard/owner?date=${encodeURIComponent(date)}`));
    } catch (error) {
      show(error.message, "error");
    } finally {
      setLoading(false);
    }
  }, [date, show]);
  useEffect(() => { load(); }, [load]);

  if (loading || !dashboard) return <section className="page"><div className="empty">Loading owner dashboard…</div></section>;

  const { summary, open, recentOrders, ongoingOrders, topOrdered, topRevenue, salesByHour, outletTimings } = dashboard;
  const pending = ongoingOrders.filter((order) => order.billLockedAt);
  const metrics = [
    ["Grand sale", rupees(summary.grand_sale)],
    ["Completed orders", summary.order_count],
    ["Discounts", rupees(summary.discount_total)],
    ["UPI", rupees(summary.upi_payment)],
    ["Cash", rupees(summary.cash_payment)],
    ["Card", rupees(summary.card_payment)],
    ["Total GST", rupees(summary.total_gst)]
  ];
  const maxHour = Math.max(1, ...salesByHour.map((bucket) => Number(bucket.sales || 0)));
  const detail = (title, subtitle, content, className = "") => <details className={`dashboard-detail ${className}`}><summary><div><h2>{title}</h2><span>{subtitle}</span></div><Icon name="chevronDown" size={18} className="details-chevron" /></summary>{content}</details>;

  return <section className="page owner-dashboard">
    <header className="page-header"><div><p className="eyebrow">OWNER CONTROL CENTRE</p><h1>Owner Dashboard</h1><p className="muted">Historical sales for the selected date. Live orders are shown separately.</p></div><div className="dashboard-controls"><input type="date" value={date} onChange={(event) => setDate(event.target.value)} /><button className="outline" onClick={load}>Refresh</button><button className="primary" onClick={onOpenReports}>Reports</button></div></header>
    <section className="dashboard-highlight"><div><span>Sales for {date}</span><strong>{rupees(summary.grand_sale)}</strong><small>{summary.order_count} completed order{summary.order_count !== 1 ? "s" : ""} · Subtotal {rupees(summary.subtotal_sale)}</small></div><div className="dashboard-tax"><span>CGST {rupees(summary.cgst_total)}</span><span>SGST {rupees(summary.sgst_total)}</span><span>Round off {signedRupees(summary.round_off_total)}</span></div></section>
    <section className="live-operations-banner"><div><span className="live-dot" />LIVE NOW · not affected by selected date</div><strong>{open.count} ongoing order{open.count !== 1 ? "s" : ""}</strong><span>{pending.length} payment pending</span></section>
    <div className="metric-grid dashboard-metrics">{metrics.map(([label, value]) => <div className="metric" key={label}><span>{label}</span><strong>{value}</strong></div>)}</div>
    <div className="dashboard-detail-column">
      {detail("Ongoing orders", "Live orders · not filtered by selected date", <div className="table-scroll"><table><thead><tr><th>Order</th><th>Table / token</th><th>Opened</th><th>KOT</th><th>Bill status</th><th className="right">Current total</th></tr></thead><tbody>{ongoingOrders.map((order) => <tr key={order.id}><td>#{order.orderNumber}</td><td>{orderLocationLabel(order)}</td><td>{formatTime(order.createdAt, timezone)}</td><td>{order.kotSequence ? `× ${order.kotSequence}` : "Pending"}</td><td>{order.billLockedAt ? <span className="pending-payment-tag">PAYMENT PENDING</span> : "Open"}</td><td className="right"><strong>{rupees(order.grandTotal)}</strong></td></tr>)}{!ongoingOrders.length && <tr><td colSpan="6" className="empty">No live open orders.</td></tr>}</tbody></table></div>, "ongoing-card")}
      {detail("Recent settlements", `Latest completed bills for ${date}`, <div className="table-scroll"><table><thead><tr><th>Order</th><th>Table / token</th><th>Time</th><th>Payment</th><th className="right">Total</th></tr></thead><tbody>{recentOrders.map((order) => <tr key={order.id}><td>#{order.orderNumber}</td><td>{orderLocationLabel(order)}</td><td>{formatTime(order.completedAt, timezone)}</td><td>{paymentSummary(order)}</td><td className="right"><strong>{rupees(order.grandTotal)}</strong></td></tr>)}{!recentOrders.length && <tr><td colSpan="5" className="empty">No settlements for this date.</td></tr>}</tbody></table></div>)}
    </div>
    <div className="dashboard-insights-grid">
      {detail("Top 5 most ordered", "Ranked by quantity sold", <InsightList rows={topOrdered} value={(row) => `${row.quantity} sold`} />)}
      {detail("Top 5 revenue items", "Ranked by billed value", <InsightList rows={topRevenue} value={(row) => rupees(row.revenue)} />)}
      {detail("Grand sales by hour", `${outletTimings.openingTime}–${outletTimings.closingTime} · 3-hour groups`, <div className="hour-bars">{salesByHour.map((bucket) => <div className="hour-bar" key={bucket.label}><div><span>{bucket.label}</span><strong>{rupees(bucket.sales)}</strong></div><i><em style={{ width: `${Math.max(3, Number(bucket.sales || 0) / maxHour * 100)}%` }} /></i></div>)}</div>, "sales-hour-card")}
    </div>
  </section>;
}

function InsightList({ rows, value }) {
  if (!rows?.length) return <div className="empty compact">No completed sales in this period.</div>;
  return <ol className="insight-list">{rows.map((row, index) => <li key={`${row.itemName}-${index}`}><span title={row.itemName}><b>{index + 1}</b>{row.itemName}</span><strong>{value(row)}</strong></li>)}</ol>;
}
function DirectQRTableView({ onOpen, onOpenKot, show, confirm, canManageTables, permissions = {}, isAdmin = false, qrEventVersion = 0, qrSoundEnabled = false, onEnableQrSound, onEnableNotifications, notificationLabel = 'Enable mobile alerts', onPendingQrOrdersChange, onQrOrdersChanged }) {
  const [tables, setTables] = useState([]);
  const [qrOrders, setQrOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [processingQr, setProcessingQr] = useState(null);
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState(null);
  const [qrCodesOpen, setQrCodesOpen] = useState(false);
  const canSendKot = isAdmin || Boolean(permissions.send_kot);
  const canPrintBill = isAdmin || Boolean(permissions.print_bill);
  const canSettle = isAdmin || Boolean(permissions.settle_payment);

  const load = useCallback(async () => {
    try {
      const [tableData, qrData] = await Promise.all([api('/tables'), api('/qr-orders')]);
      const nextOrders = qrData.orders || [];
      setTables(tableData.tables || []);
      setQrOrders(nextOrders);
      onPendingQrOrdersChange?.(nextOrders.length);
    } catch (error) { show(error.message, 'error'); }
    finally { setLoading(false); }
  }, [show, onPendingQrOrdersChange]);
  useEffect(() => {
    load();
    const timer = window.setInterval(load, 15000);
    return () => window.clearInterval(timer);
  }, [load, qrEventVersion]);

  const acceptQrOrder = async (order) => {
    const accepted = await confirm({
      title: `Accept QR order for ${order.tableName}?`,
      message: 'The request will join this table’s open DirectQR bill. KOT printing remains manual.',
      confirmLabel: 'Accept order',
    });
    if (!accepted) return;
    try {
      setProcessingQr(order.id);
      const result = await api(`/qr-orders/${order.id}/accept`, { method: 'POST', body: JSON.stringify({}) });
      show(result.mergedIntoExistingOrder ? `Accepted and merged into ${order.tableName}.` : `Accepted. ${order.tableName} is now open.`);
      await load();
      await onQrOrdersChanged?.();
    } catch (error) { show(error.message, 'error'); }
    finally { setProcessingQr(null); }
  };
  const rejectQrOrder = async (order) => {
    const accepted = await confirm({ title: `Reject QR order for ${order.tableName}?`, message: 'The customer will see that this order could not be accepted. No bill or KOT is created.', confirmLabel: 'Reject order', tone: 'danger' });
    if (!accepted) return;
    try {
      setProcessingQr(order.id);
      await api(`/qr-orders/${order.id}/reject`, { method: 'POST', body: JSON.stringify({}) });
      show('QR order rejected.');
      await load();
      await onQrOrdersChanged?.();
    } catch (error) { show(error.message, 'error'); }
    finally { setProcessingQr(null); }
  };
  const addTable = async () => {
    try { setAdding(true); const data = await api('/tables/next', { method: 'POST', body: JSON.stringify({}) }); show(`${data.table.name} added.`); await load(); }
    catch (error) { show(error.message, 'error'); }
    finally { setAdding(false); }
  };
  const deleteTable = async (event, table) => {
    event.stopPropagation();
    const accepted = await confirm({ title: `Delete ${table.name}?`, message: 'The table is free. Historical DirectQR orders remain intact.', confirmLabel: 'Delete table', tone: 'danger' });
    if (!accepted) return;
    try { setDeleting(table.id); await api(`/tables/${table.id}`, { method: 'DELETE', body: JSON.stringify({}) }); show(`${table.name} deleted.`); await load(); }
    catch (error) { show(error.message, 'error'); }
    finally { setDeleting(null); }
  };
  const quick = (event, table, action) => { event.stopPropagation(); if (table.open_order_id) onOpen(table, action); };
  const renderTable = (table) => {
    const status = tableStatus(table);
    const isOpen = Boolean(table.open_order_id);
    return <article className={`table-card directqr-table-card ${isOpen ? 'occupied' : ''} status-${status.tone}`} key={table.id}>
      <button className="table-card-main" onClick={() => isOpen ? onOpen(table) : show('This table can be opened only after a customer QR order is accepted.', 'error')}>
        <div className="table-top"><strong>{table.name}</strong><span>{status.label}</span></div>
        {isOpen ? <>
          <div className="table-total">{rupees(table.grand_total)}</div>
          <small>#{table.order_number} · {table.item_count} item{Number(table.item_count) !== 1 ? 's' : ''}</small>
          <small className="kot-label">{table.bill_locked_at ? 'Bill printed · payment pending' : Number(table.kot_sequence || 0) ? `KOT × ${table.kot_sequence}` : 'KOT pending'}</small>
        </> : <div className="directqr-free-table"><Icon name="qr" size={16} />Awaiting customer QR order</div>}
      </button>
      {isOpen && <div className="table-quick-actions">
        {!table.bill_locked_at && canSendKot && <button title="Print KOT" onClick={(event) => quick(event, table, 'KOT')}><Icon name="printer" size={15} /></button>}
        {!table.bill_locked_at && canPrintBill && <button title="Print bill" onClick={(event) => quick(event, table, 'PRINT_BILL')}><Icon name="bill" size={15} /></button>}
        {table.bill_locked_at && canSettle && <button title="Settle payment" onClick={(event) => quick(event, table, 'SETTLE')}><Icon name="wallet" size={15} /></button>}
      </div>}
      {!isOpen && canManageTables && <button className="table-delete" title={`Delete ${table.name}`} onClick={(event) => deleteTable(event, table)} disabled={deleting === table.id}>{deleting === table.id ? '…' : <Icon name="trash" size={14} />}</button>}
    </article>;
  };

  return <section className="page table-view-page directqr-operations-page">
    <header className="page-header"><div><p className="eyebrow">DIRECTQR LIVE OPERATIONS</p><h1>QR Orders & tables</h1><p className="muted">Only customer QR requests can open a table. Accept, print KOT, bill and settle from the same flow.</p></div><div className="header-actions">{isAdmin && <button className="outline qr-codes-launch" onClick={() => setQrCodesOpen(true)}><Icon name="qr" size={16} />QR codes</button>}<button className="outline" onClick={onOpenKot}>KOT view</button><button className="outline" onClick={load}>Refresh</button></div></header>
    <section className="qr-orders-view directqr-queue">
      <div className="takeaway-intro qr-orders-intro"><div><p className="eyebrow">PENDING CUSTOMER REQUESTS</p><h2>QR Orders {qrOrders.length ? <b className="qr-order-count">{qrOrders.length}</b> : null}</h2><p>New requests wait for staff review. The alert keeps repeating until the queue is clear.</p></div><div className="qr-alert-controls">{!qrSoundEnabled && <button className="outline" onClick={onEnableQrSound}><Icon name="bell" size={15} />Enable order sound</button>}{qrSoundEnabled && <span className="sound-enabled"><Icon name="bell" size={14} />Sound on</span>}<button className="outline" onClick={onEnableNotifications}><Icon name="bell" size={15} />{notificationLabel}</button></div></div>
      {loading ? <div className="empty">Loading DirectQR orders…</div> : !qrOrders.length ? <div className="empty">No QR orders are waiting. Customers can scan their table code to place an order.</div> : <div className="qr-order-grid">{qrOrders.map((order) => <article className="qr-order-card" key={order.id}>
        <header><div><span className="qr-order-kicker">NEW DIRECTQR ORDER</span><h3>{order.tableName}</h3></div><time>{new Date(order.receivedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></header>
        <div className="qr-customer"><strong>{order.customer.displayName}</strong><span>@{order.customer.username} · {order.customer.phone}</span>{order.guestCount ? <small>{order.guestCount} guest{order.guestCount === 1 ? '' : 's'}</small> : null}</div>
        <ul className="qr-order-items">{order.items.map((item, index) => <li key={`${item.menuItemId}-${index}`}><span><b>{item.quantity}×</b> {item.itemName}{item.addons?.length ? <small>{item.addons.map((addon) => addon.name).join(', ')}</small> : null}</span><strong>{rupees(item.lineTotal)}</strong></li>)}</ul>
        {order.notes ? <p className="qr-order-note">“{order.notes}”</p> : null}
        <div className="qr-order-total"><span>Total</span><strong>{rupees(order.grandTotal)}</strong></div>
        <footer><button className="outline danger-text" onClick={() => rejectQrOrder(order)} disabled={processingQr === order.id}>Reject</button><button className="primary" onClick={() => acceptQrOrder(order)} disabled={processingQr === order.id}>{processingQr === order.id ? 'Processing…' : 'Accept order'}</button></footer>
      </article>)}</div>}
    </section>
    <section className="directqr-floor-section"><div className="section-inline-heading"><div><p className="eyebrow">LIVE TABLE SESSIONS</p><h2>Tables</h2></div><div className="legend"><span><i className="dot free" />Awaiting QR order</span><span><i className="dot busy" />Open order</span><span><i className="dot pending" />Needs attention <b className="needs-attention-pill">Attention</b></span></div></div>
      {loading ? <div className="empty">Loading tables…</div> : <div className="table-grid">{tables.map(renderTable)}{canManageTables && <button className="table-card table-add-card" onClick={addTable} disabled={adding}><span><Icon name="plus" size={21} /></span><strong>{adding ? 'Adding…' : 'Add table'}</strong><small>Creates table and a secure DirectQR token</small></button>}</div>}
    </section>
    {qrCodesOpen && <TableQrCodesModal onClose={() => setQrCodesOpen(false)} show={show} />}
  </section>;
}

function TableView({ onOpen, onOpenKot, show, confirm, canManageTables, permissions = {}, isAdmin = false, directQrOrdering = false, qrEventVersion = 0, qrSoundEnabled = false, onEnableQrSound, onQrOrdersChanged }) {
  const [tables, setTables] = useState([]);
  const [takeaways, setTakeaways] = useState([]);
  const [qrOrders, setQrOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [processingQr, setProcessingQr] = useState(null);
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState(null);
  const [mode, setMode] = useState("dine-in");
  const [qrCodesOpen, setQrCodesOpen] = useState(false);
  const canCreate = isAdmin || Boolean(permissions.create_orders);
  const canSendKot = isAdmin || Boolean(permissions.send_kot);
  const canPrintBill = isAdmin || Boolean(permissions.print_bill);
  const canSettle = isAdmin || Boolean(permissions.settle_payment);

  const load = useCallback(async () => {
    try {
      const [tableData, takeawayData, qrData] = await Promise.all([api("/tables"), api("/takeaways"), directQrOrdering ? api("/qr-orders") : Promise.resolve({ orders: [] })]);
      setTables(tableData.tables || []);
      setTakeaways(takeawayData.takeaways || []);
      setQrOrders(qrData.orders || []);
    } catch (error) {
      show(error.message, "error");
    } finally {
      setLoading(false);
    }
  }, [show, directQrOrdering]);
  useEffect(() => {
    load();
    const timer = window.setInterval(load, 15000);
    return () => window.clearInterval(timer);
  }, [load, qrEventVersion]);

  const quick = (event, order, action) => {
    event.stopPropagation();
    onOpen(order, action);
  };
  const addTable = async () => {
    try {
      setAdding(true);
      const data = await api("/tables/next", { method: "POST", body: JSON.stringify({}) });
      show(`${data.table.name} added.`);
      await load();
    } catch (error) {
      show(error.message, "error");
    } finally {
      setAdding(false);
    }
  };
  const deleteTable = async (event, table) => {
    event.stopPropagation();
    const accepted = await confirm({ title: `Delete ${table.name}?`, message: "This table is free. It will be removed from Table View; historical bills remain unchanged.", confirmLabel: "Delete table", tone: "danger" });
    if (!accepted) return;
    try {
      setDeleting(table.id);
      await api(`/tables/${table.id}`, { method: "DELETE", body: JSON.stringify({}) });
      show(`${table.name} deleted.`);
      await load();
    } catch (error) {
      show(error.message, "error");
    } finally {
      setDeleting(null);
    }
  };

  const acceptQrOrder = async (order) => {
    const accepted = await confirm({ title: `Accept QR order for ${order.tableName}?`, message: 'This will create the dine-in order on the table using the customer details and selected items.', confirmLabel: 'Accept order' });
    if (!accepted) return;
    try {
      setProcessingQr(order.id);
      const result = await api(`/qr-orders/${order.id}/accept`, { method: 'POST', body: JSON.stringify({}) });
      show(result.mergedIntoExistingOrder ? `QR order accepted and added to the open bill on ${order.tableName}.` : `QR order accepted. It is now open on ${order.tableName}.`);
      await load();
      await onQrOrdersChanged?.();
      return result;
    } catch (error) {
      show(error.message, 'error');
    } finally {
      setProcessingQr(null);
    }
  };
  const rejectQrOrder = async (order) => {
    const accepted = await confirm({ title: `Reject QR order for ${order.tableName}?`, message: 'The customer will see that this order could not be accepted. No KOT will be created.', confirmLabel: 'Reject order', tone: 'danger' });
    if (!accepted) return;
    try {
      setProcessingQr(order.id);
      await api(`/qr-orders/${order.id}/reject`, { method: 'POST', body: JSON.stringify({}) });
      show('QR order rejected.');
      await load();
      await onQrOrdersChanged?.();
    } catch (error) {
      show(error.message, 'error');
    } finally {
      setProcessingQr(null);
    }
  };
  const renderOrderActions = (order, location) => order.open_order_id && <div className="table-quick-actions">
    {!order.bill_locked_at && canSendKot && <button title="Print KOT" aria-label={`Print KOT for ${location}`} onClick={(event) => quick(event, order, "KOT")}><Icon name="printer" size={15} /></button>}
    {!order.bill_locked_at && canPrintBill && <button title="Print bill" aria-label={`Print bill for ${location}`} onClick={(event) => quick(event, order, "PRINT_BILL")}><Icon name="bill" size={15} /></button>}
    {order.bill_locked_at && canSettle && <button title="Settle payment" aria-label={`Settle ${location}`} onClick={(event) => quick(event, order, "SETTLE")}><Icon name="wallet" size={15} /></button>}
  </div>;

  const renderOrderCard = (order, key = order.id) => {
    const status = tableStatus(order);
    const location = orderLocationLabel(order);
    return <article key={key} className={`table-card ${order.open_order_id ? "occupied" : ""} status-${status.tone} status-${status.key.toLowerCase()}`}>
      <button className="table-card-main" onClick={() => onOpen(order)}>
        <div className="table-top"><strong title={location}>{location}</strong><span title={status.label}>{status.label}</span></div>
        {order.open_order_id ? <>
          <div className="table-total">{rupees(order.grand_total)}</div>
          <small>#{order.order_number} · {order.item_count} item{Number(order.item_count) !== 1 ? "s" : ""}</small>
          {Number(order.kot_sequence || 0) > 0 && <small className="kot-label">KOT × {order.kot_sequence}</small>}
        </> : <div className="start-order">Start order <Icon name="plus" size={14} /></div>}
      </button>
      {!order.open_order_id && canManageTables && <button className="table-delete" title={`Delete ${order.name}`} onClick={(event) => deleteTable(event, order)} disabled={deleting === order.id}>{deleting === order.id ? "…" : <Icon name="trash" size={14} />}</button>}
      {renderOrderActions(order, location)}
    </article>;
  };

  return <section className="page table-view-page">
    <header className="page-header"><div><p className="eyebrow">LIVE FLOOR</p><h1>Table View</h1><p className="muted">Start dine-in or takeaway orders from one operational screen.</p></div><div className="header-actions">{isAdmin && directQrOrdering && <button className="outline qr-codes-launch" onClick={() => setQrCodesOpen(true)}><Icon name="qr" size={16} />QR codes</button>}<button className="outline" onClick={onOpenKot}>KOT view</button><button className="outline" onClick={load}>Refresh</button></div></header>
    <div className="table-mode-switch" role="tablist" aria-label="Choose order type"><button type="button" role="tab" aria-selected={mode === "dine-in"} className={mode === "dine-in" ? "active" : ""} onClick={() => setMode("dine-in")}><Icon name="tables" size={16} />Dine-in tables</button><button type="button" role="tab" aria-selected={mode === "takeaway"} className={mode === "takeaway" ? "active" : ""} onClick={() => setMode("takeaway")}><Icon name="takeaway" size={16} />Takeaway orders</button>{directQrOrdering && <button type="button" role="tab" aria-selected={mode === "qr"} className={mode === "qr" ? "active" : ""} onClick={() => setMode("qr")}><Icon name="bell" size={16} />QR Orders{qrOrders.length ? <b className="qr-order-count">{qrOrders.length}</b> : null}</button>}</div>
    {mode === "dine-in" && <>
      <div className="legend"><span><i className="dot free" />Free</span><span><i className="dot busy" />Kitchen / order activity</span><span><i className="dot pending" />Needs attention <b className="needs-attention-pill">Attention</b></span></div>
      {loading ? <div className="empty">Loading tables…</div> : <div className="table-grid">{tables.map((table) => renderOrderCard(table))}{canManageTables && <button className="table-card table-add-card" onClick={addTable} disabled={adding}><span><Icon name="plus" size={21} /></span><strong>{adding ? "Adding…" : "Add table"}</strong><small>Creates one table</small></button>}</div>}
    </>}
    {mode === "takeaway" && <section className="takeaway-view">
      <div className="takeaway-intro"><div><h2>Takeaway orders</h2><p>Tokens are created daily and printed on KOTs and bills.</p></div><span>{takeaways.length} open</span></div>
      {loading ? <div className="empty">Loading takeaway orders…</div> : <div className="table-grid takeaway-grid">
        {canCreate && <button className="table-card takeaway-add-card" onClick={() => onOpen({ order_type: "TAKEAWAY", orderType: "TAKEAWAY", name: "Takeaway" })}><span><Icon name="plus" size={22} /></span><strong>New takeaway</strong><small>Create a takeaway token</small></button>}
        {takeaways.map((order) => renderOrderCard(order, order.open_order_id))}
        {!takeaways.length && !canCreate && <div className="empty">No open takeaway orders.</div>}
      </div>}
    </section>}
    {directQrOrdering && mode === "qr" && <section className="qr-orders-view">
      <div className="takeaway-intro qr-orders-intro"><div><h2>QR Orders</h2><p>Customer orders wait here until a staff member accepts or rejects them.</p></div><div className="qr-sound-control">{!qrSoundEnabled && <button className="outline" onClick={onEnableQrSound}><Icon name="bell" size={15} />Enable order sound</button>}{qrSoundEnabled && <span className="sound-enabled"><Icon name="bell" size={14} />Sound on</span>}</div></div>
      {loading ? <div className="empty">Loading QR orders…</div> : !qrOrders.length ? <div className="empty">No QR orders are waiting.</div> : <div className="qr-order-grid">{qrOrders.map((order) => <article className="qr-order-card" key={order.id}>
        <header><div><span className="qr-order-kicker">NEW QR ORDER</span><h3>{order.tableName}</h3></div><time>{new Date(order.receivedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></header>
        <div className="qr-customer"><strong>{order.customer.displayName}</strong><span>@{order.customer.username} · {order.customer.phone}</span>{order.guestCount ? <small>{order.guestCount} guest{order.guestCount === 1 ? '' : 's'}</small> : null}</div>
        <ul className="qr-order-items">{order.items.map((item, index) => <li key={`${item.menuItemId}-${index}`}><span><b>{item.quantity}×</b> {item.itemName}{item.addons?.length ? <small>{item.addons.map((addon) => addon.name).join(', ')}</small> : null}</span><strong>{rupees(item.lineTotal)}</strong></li>)}</ul>
        {order.notes ? <p className="qr-order-note">“{order.notes}”</p> : null}
        <div className="qr-order-total"><span>Total</span><strong>{rupees(order.grandTotal)}</strong></div>
        <footer><button className="outline danger-text" onClick={() => rejectQrOrder(order)} disabled={processingQr === order.id}>Reject</button><button className="primary" onClick={() => acceptQrOrder(order)} disabled={processingQr === order.id}>{processingQr === order.id ? 'Processing…' : 'Accept order'}</button></footer>
      </article>)}</div>}
    </section>}
    {qrCodesOpen && <TableQrCodesModal onClose={() => setQrCodesOpen(false)} show={show} />}
  </section>;
}


function qrFilenameSegment(value) {
  const cleaned = String(value || 'qr').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned || 'qr';
}
async function qrPngDataUrl(value, width = 900) {
  return QRCode.toDataURL(value, {
    type: 'image/png',
    errorCorrectionLevel: 'M',
    margin: 2,
    width,
    color: { dark: '#0B1626', light: '#FFFFFF' }
  });
}
function triggerBlobDownload(blob, filename) {
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = objectUrl;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
}
function QrPreview({ value, label }) {
  const [src, setSrc] = useState('');
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    setSrc('');
    setFailed(false);
    qrPngDataUrl(value, 420).then((dataUrl) => {
      if (active) setSrc(dataUrl);
    }).catch(() => {
      if (active) setFailed(true);
    });
    return () => { active = false; };
  }, [value]);
  if (failed) return <div className="qr-preview-placeholder" role="alert">Could not generate QR</div>;
  if (!src) return <div className="qr-preview-placeholder">Generating QR…</div>;
  return <img className="qr-preview-image" src={src} alt={`QR code for ${label}`} />;
}
function openQrPrintWindow(title) {
  const win = window.open('', '_blank', 'width=940,height=820');
  if (!win) throw new Error('Popup blocked. Allow popups for this POS before printing QR codes.');
  win.document.write(`<!doctype html><title>${escapeHtml(title)}</title><p style="font-family:Arial;padding:16px">Preparing QR print sheet…</p>`);
  return win;
}
async function printTableQrCards(codes, restaurantName) {
  const win = openQrPrintWindow(codes.length === 1 ? `${codes[0].tableName} QR code` : 'Table QR codes');
  try {
    const cards = await Promise.all(codes.map(async (code) => ({ ...code, image: await qrPngDataUrl(code.url, 620) })));
    const markup = cards.map((code) => `<article class="qr-card"><div class="qr-brand">${escapeHtml(restaurantName)}</div><div class="qr-prompt">SCAN TO ORDER</div><img src="${code.image}" alt="QR code for ${escapeHtml(code.tableName)}"><h1>${escapeHtml(code.tableName)}</h1><p>Scan this QR code to browse the menu and place your order.</p></article>`).join('');
    win.onload = () => { win.focus(); win.print(); };
    win.onafterprint = () => { if (!win.closed) win.close(); };
    win.document.open();
    win.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(restaurantName)} table QR codes</title><style>@page{size:A4 portrait;margin:10mm}*{box-sizing:border-box}body{margin:0;font-family:Arial,sans-serif;color:#101828}.qr-print-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10mm}.qr-card{min-height:128mm;display:grid;align-content:start;justify-items:center;padding:9mm;border:1.5px dashed #596579;border-radius:5mm;text-align:center;break-inside:avoid}.qr-brand{font-size:15px;font-weight:800}.qr-prompt{margin:4mm 0 3mm;color:#175fc5;font-size:10px;font-weight:900;letter-spacing:.13em}.qr-card img{display:block;width:58mm;height:58mm;image-rendering:pixelated}.qr-card h1{margin:4mm 0 2mm;font-size:22px}.qr-card p{max-width:65mm;margin:0;color:#475467;font-size:10px;line-height:1.35}@media print{body{margin:0}}</style></head><body><main class="qr-print-grid">${markup}</main></body></html>`);
    win.document.close();
  } catch (error) {
    if (!win.closed) win.close();
    throw error;
  }
}
function TableQrCodesModal({ onClose, show }) {
  const [data, setData] = useState({ restaurantName: '', tables: [] });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const load = useCallback(async () => {
    try {
      setLoading(true);
      const result = await api('/qr/table-codes');
      setData({ restaurantName: result.restaurantName || '', tables: result.tables || [] });
    } catch (error) {
      show(error.message, 'error');
    } finally {
      setLoading(false);
    }
  }, [show]);
  useEffect(() => { load(); }, [load]);
  const copyLink = async (code) => {
    try {
      await navigator.clipboard.writeText(code.url);
      show(`${code.tableName} DirectQR link copied.`);
    } catch {
      show('Could not copy the QR link. Copy it manually from the QR screen.', 'error');
    }
  };
  const downloadOne = async (code) => {
    try {
      setBusy(`download:${code.id}`);
      const dataUrl = await qrPngDataUrl(code.url, 1200);
      const base64 = dataUrl.split(',')[1];
      triggerBlobDownload(new Blob([Uint8Array.from(atob(base64), (character) => character.charCodeAt(0))], { type: 'image/png' }), `${qrFilenameSegment(data.restaurantName)}-${qrFilenameSegment(code.tableName)}-qr.png`);
      show(`${code.tableName} QR downloaded.`);
    } catch (error) {
      show(error.message || 'Could not download the QR code.', 'error');
    } finally {
      setBusy('');
    }
  };
  const downloadPack = async () => {
    if (!data.tables.length) return;
    try {
      setBusy('download-pack');
      const zip = new JSZip();
      await Promise.all(data.tables.map(async (code) => {
        const dataUrl = await qrPngDataUrl(code.url, 1200);
        zip.file(`${qrFilenameSegment(code.tableName)}-qr.png`, dataUrl.split(',')[1], { base64: true });
      }));
      const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
      triggerBlobDownload(blob, `${qrFilenameSegment(data.restaurantName)}-table-qr-pack.zip`);
      show('Table QR pack downloaded.');
    } catch (error) {
      show(error.message || 'Could not create the QR pack.', 'error');
    } finally {
      setBusy('');
    }
  };
  const print = async (codes) => {
    try {
      setBusy(codes.length === 1 ? `print:${codes[0].id}` : 'print-all');
      await printTableQrCards(codes, data.restaurantName || 'Restaurant');
    } catch (error) {
      show(error.message || 'Could not prepare QR print sheet.', 'error');
    } finally {
      setBusy('');
    }
  };
  return <Modal title="Table QR Codes" onClose={onClose} variant="qr-code-modal"><div className="qr-codes-modal-body">
    <section className="qr-codes-intro"><div><p className="eyebrow">DIRECTQR SETUP</p><h3>{data.restaurantName || 'Your outlet'} table ordering</h3><p>Print and place one QR code on each table. Customers scan it to open the correct table menu—no DirectQR console access is required.</p></div><span>{data.tables.length} active table{data.tables.length === 1 ? '' : 's'}</span></section>
    <div className="qr-codes-toolbar"><button className="primary" onClick={() => print(data.tables)} disabled={loading || !data.tables.length || busy}><Icon name="printer" size={16} />{busy === 'print-all' ? 'Preparing…' : 'Print all table QRs'}</button><button className="outline" onClick={downloadPack} disabled={loading || !data.tables.length || busy}><Icon name="download" size={16} />{busy === 'download-pack' ? 'Packaging…' : 'Download QR pack'}</button><button className="outline icon-label-button" title="Refresh table QR list" aria-label="Refresh table QR list" onClick={load} disabled={loading || Boolean(busy)}><Icon name="refresh" size={16} />Refresh</button></div>
    {loading ? <div className="empty">Loading table QR codes…</div> : !data.tables.length ? <div className="empty">No active tables yet. Add a table in Table View, then return here to print its QR code.</div> : <div className="table-qr-grid">{data.tables.map((code) => <article className="table-qr-card" key={code.id}><div className="table-qr-preview"><QrPreview value={code.url} label={code.tableName} /></div><div className="table-qr-copy"><span>DIRECTQR · {data.restaurantName}</span><h3>{code.tableName}</h3><p>Each code stays linked to this table.</p></div><div className="table-qr-actions"><button className="outline" onClick={() => print([code])} disabled={Boolean(busy)}><Icon name="printer" size={15} />{busy === `print:${code.id}` ? 'Preparing…' : 'Print'}</button><button className="outline" onClick={() => downloadOne(code)} disabled={Boolean(busy)}><Icon name="download" size={15} />{busy === `download:${code.id}` ? 'Downloading…' : 'PNG'}</button><button className="text-button" onClick={() => copyLink(code)} disabled={Boolean(busy)}><Icon name="link" size={15} />Copy link</button></div></article>)}</div>}
    <p className="qr-code-security-note">Use the printed code at the matching table only. The link contains a secure table token and should not be edited manually.</p>
  </div></Modal>;
}

function KotView({ onOpen, onOpenTables, show }) {
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    try {
      const data = await api("/kot-view");
      setOrders(data.orders || []);
    } catch (error) {
      show(error.message, "error");
    } finally {
      setLoading(false);
    }
  }, [show]);
  useEffect(() => {
    load();
    const timer = window.setInterval(load, 12000);
    return () => window.clearInterval(timer);
  }, [load]);
  const sentStatus = (item) => {
    if (!item.sentQuantity) return "Not sent";
    const ids = item.sentKotNumbers?.length ? `KOT #${item.sentKotNumbers.join(", #")}` : "KOT sent";
    return item.unsentQuantity ? `${ids} sent × ${item.sentQuantity} · Not sent × ${item.unsentQuantity}` : `${ids} sent`;
  };

  return <section className="page kot-view">
    <header className="page-header"><div><p className="eyebrow">KITCHEN QUEUE</p><h1>KOT View</h1><p className="muted">All live orders. Items show whether they have reached the kitchen.</p></div><div className="header-actions"><button className="outline" onClick={onOpenTables}>Live QR orders</button><button className="outline" onClick={load}>Refresh</button></div></header>
    {loading ? <div className="empty">Loading KOTs…</div> : !orders.length ? <div className="empty">No active KOTs. All tables and takeaway orders are clear.</div> : <div className="kot-view-grid">
      {orders.map((order) => <details className="kot-view-card" key={order.id}>
        <summary className="kot-view-head"><div><strong>{orderLocationLabel(order)}</strong><span>Order #{order.orderNumber}{order.billLockedAt ? " · Payment pending" : ""}</span></div><span className="kot-head-action"><b>{order.kotCount ? `KOT × ${order.kotCount}` : "KOT pending"}</b><Icon name="chevronDown" size={16} className="kot-toggle-icon" /></span></summary>
        <div className="kot-card-body"><div className="table-scroll kot-current-items"><table><thead><tr><th>Item</th><th className="right">Qty</th><th>Status</th></tr></thead><tbody>{order.items.map((item, index) => <tr key={item.id}><td><strong>{index + 1}. {item.itemName}</strong>{(item.addons || []).map((addon) => <small key={addon.id || addon.name}>↳ {addon.name} × {item.quantity}</small>)}</td><td className="right">{item.quantity}</td><td><span className={`kot-status ${item.sentQuantity ? "sent" : "unsent"}`}>{sentStatus(item)}</span></td></tr>)}</tbody></table></div>
          <details className="kot-batches"><summary>KOT print history {order.kotBatches.length ? `(${order.kotBatches.length})` : ""}</summary>{order.kotBatches.length ? <div className="kot-batch-list">{order.kotBatches.map((batch) => <section className="kot-batch" key={batch.sequence}><div><strong>KOT #{batch.dailyKotNumber}</strong><span>{formatTime(batch.printedAt, "Asia/Kolkata")}</span></div><ul>{batch.items.map((item, index) => <li key={`${batch.sequence}-${index}`}><span>{item.itemName}</span><b>× {item.quantity}</b></li>)}</ul></section>)}</div> : <p className="muted">No KOT printed yet.</p>}</details>
          <button className="outline wide" onClick={() => onOpen({ id: order.tableId, open_order_id: order.id, order_number: order.orderNumber, kot_sequence: order.kotCount, bill_locked_at: order.billLockedAt, order_type: order.orderType, orderType: order.orderType, takeaway_token: order.takeawayToken, takeawayToken: order.takeawayToken, name: orderLocationLabel(order) })}>{order.orderType === "TAKEAWAY" ? "Open takeaway order" : "Open table order"}</button>
        </div>
      </details>)}
    </div>}
  </section>;
}

function OrderView({ table, quickAction, onQuickActionHandled, permissions = {}, isAdmin, canVoid, confirm, requestForm, onDirtyChange, onBack, show }) {
  const [menu, setMenu] = useState({ categories: [], items: [], containerChargeGstRate: 5 });
  const [categoryId, setCategoryId] = useState(null);
  const [cart, setCart] = useState([]);
  const [orderId, setOrderId] = useState(table?.open_order_id || null);
  const [revision, setRevision] = useState(table?.revision || null);
  const [kotSequence, setKotSequence] = useState(Number(table?.kot_sequence || 0));
  const [orderType, setOrderType] = useState(table?.order_type || table?.orderType || "DINE_IN");
  const [takeawayToken, setTakeawayToken] = useState(table?.takeaway_token ?? table?.takeawayToken ?? null);
  const [discountType, setDiscountType] = useState(null);
  const [discountValue, setDiscountValue] = useState(0);
  const [containerCharge, setContainerCharge] = useState(0);
  const [containerGstRate, setContainerGstRate] = useState(5);
  const [notes, setNotes] = useState("");
  const [customerName, setCustomerName] = useState("");
  const [customerMobile, setCustomerMobile] = useState("");
  const [cartUtilityPanel, setCartUtilityPanel] = useState(null);
  const [billLocked, setBillLocked] = useState(Boolean(table?.bill_locked_at));
  const [loading, setLoading] = useState(true);
  const [menuSearch, setMenuSearch] = useState("");
  const [busyAction, setBusyAction] = useState("");
  const [addonTarget, setAddonTarget] = useState(null);
  const [settlementOpen, setSettlementOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [calculationOpen, setCalculationOpen] = useState(false);
  const canCreate = isAdmin || Boolean(permissions.create_orders);
  const canSendKot = isAdmin || Boolean(permissions.send_kot);
  const canPrintBill = isAdmin || Boolean(permissions.print_bill);
  const canSettle = isAdmin || Boolean(permissions.settle_payment);
  const canDiscount = isAdmin || Boolean(permissions.apply_discount);

  const load = useCallback(async () => {
    try {
      const menuData = await api("/menu");
      setMenu(menuData);
      setContainerGstRate(Number(menuData.containerChargeGstRate ?? 5));
      setCategoryId((current) => current || menuData.categories[0]?.id || null);
      setOrderType(table?.order_type || table?.orderType || "DINE_IN");
      setTakeawayToken(table?.takeaway_token ?? table?.takeawayToken ?? null);
      if (table?.open_order_id) {
        const { order } = await api(`/orders/${table.open_order_id}`);
        setOrderId(order.id);
        setRevision(order.revision);
        setKotSequence(order.kot_sequence || 0);
        setBillLocked(Boolean(order.bill_locked_at));
        setOrderType(order.order_type || "DINE_IN");
        setTakeawayToken(order.takeaway_token ?? null);
        setCustomerName(order.customer_name || "");
        setCustomerMobile(order.customer_mobile || "");
        setCart(order.items.map((item) => {
          const addonIds = (item.addons_snapshot || []).map((addon) => addon.id).sort();
          return {
            menuItemId: item.menu_item_id,
            quantity: item.quantity,
            addonOptionIds: addonIds,
            localKey: `${item.menu_item_id}-${JSON.stringify(addonIds)}`,
            snapshot: {
              itemName: item.item_name,
              unitPrice: item.unit_price,
              gstRate: item.gst_rate,
              gstInclusive: item.gst_inclusive,
              addonUnitTotal: item.addon_unit_total,
              addonsSnapshot: item.addons_snapshot || [],
              sentToKitchenQty: item.sent_to_kitchen_qty
            }
          };
        }));
        setDiscountType(order.discount_type || null);
        setDiscountValue(Number(order.discount_value || 0));
        setContainerCharge(Number(order.container_charge || 0));
        setContainerGstRate(Number(order.container_gst_rate ?? menuData.containerChargeGstRate ?? 5));
        setNotes(order.notes || "");
      } else {
        setOrderId(null);
        setRevision(null);
        setKotSequence(0);
        setBillLocked(false);
        setCart([]);
        setDiscountType(null);
        setDiscountValue(0);
        setContainerCharge(0);
        setNotes("");
        setCustomerName("");
        setCustomerMobile("");
      }
      setDirty(false);
    } catch (error) {
      show(error.message, "error");
    } finally {
      setLoading(false);
    }
  }, [show, table]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { onDirtyChange(dirty); }, [dirty, onDirtyChange]);

  const normalizedSearch = menuSearch.trim().toLowerCase();
  const activeCategory = menu.categories.find((category) => category.id === categoryId);
  const activeItems = menu.items.filter((item) => normalizedSearch ? item.name.toLowerCase().includes(normalizedSearch) : !categoryId || item.categoryId === categoryId);
  const categoryById = useMemo(() => new Map(menu.categories.map((category) => [category.id, category])), [menu.categories]);
  const cartDetails = useMemo(() => cart.map((entry) => {
    const currentItem = menu.items.find((item) => item.id === entry.menuItemId);
    const snapshot = entry.snapshot;
    if (!currentItem && !snapshot) return null;
    const item = snapshot ? { id: entry.menuItemId, name: snapshot.itemName, price: snapshot.unitPrice, gstRate: snapshot.gstRate, gstInclusive: snapshot.gstInclusive } : currentItem;
    const addons = snapshot ? snapshot.addonsSnapshot : currentItem.addonGroups.flatMap((group) => group.options).filter((option) => entry.addonOptionIds.includes(option.id));
    const addonUnitTotal = snapshot ? Number(snapshot.addonUnitTotal || 0) : addons.reduce((sum, addon) => sum + Number(addon.price), 0);
    return { ...entry, item, addons, addonUnitTotal, baseLineAmount: Number(item.price) * entry.quantity, addonLineAmount: addonUnitTotal * entry.quantity };
  }).filter(Boolean), [cart, menu]);
  const estimate = useMemo(() => calculateCart(
    cartDetails.map((entry) => ({ unitPrice: entry.item.price, addonUnitTotal: entry.addonUnitTotal, quantity: entry.quantity, gstRate: entry.item.gstRate, gstInclusive: entry.item.gstInclusive })),
    discountType,
    discountValue,
    { containerCharge: Number(containerCharge || 0), containerGstRate: Number(containerGstRate || 0) }
  ), [cartDetails, discountType, discountValue, containerCharge, containerGstRate]);

  const markDirty = (writer) => {
    if (billLocked) return;
    setCart(writer);
    setDirty(true);
  };
  const addConfigured = (item, addonOptionIds) => {
    if (billLocked) return;
    const sortedIds = [...addonOptionIds].sort();
    const key = `${item.id}-${JSON.stringify(sortedIds)}`;
    markDirty((old) => {
      const found = old.find((entry) => entry.localKey === key);
      return found ? old.map((entry) => entry.localKey === key ? { ...entry, quantity: entry.quantity + 1 } : entry) : [...old, { menuItemId: item.id, quantity: 1, addonOptionIds: sortedIds, localKey: key }];
    });
    setAddonTarget(null);
  };
  const addItem = (item) => {
    if (billLocked || !canCreate) return;
    if (item.addonGroups.length) {
      setAddonTarget(item);
      return;
    }
    addConfigured(item, []);
  };
  const changeQty = (key, delta) => markDirty((old) => old.map((entry) => {
    if (entry.localKey !== key) return entry;
    const minimum = Number(entry.snapshot?.sentToKitchenQty || 0);
    return { ...entry, quantity: Math.max(minimum, entry.quantity + delta) };
  }).filter((entry) => entry.quantity > 0));
  const setOptionalValue = (setter) => (event) => {
    setter(event.target.value);
    setDirty(true);
  };
  const buildDraft = () => ({
    tableId: orderType === "DINE_IN" ? table?.id || null : null,
    orderType,
    items: cart.map(({ menuItemId, quantity, addonOptionIds }) => ({ menuItemId, quantity, addonOptionIds })),
    discountType,
    discountValue: Number(discountValue || 0),
    containerCharge: Number(containerCharge || 0),
    notes,
    customerName,
    customerMobile
  });
  const saveOrder = async () => {
    if (billLocked) throw new Error("This printed bill is locked pending payment.");
    if (!cart.length) throw new Error("Add at least one item before saving staff changes.");
    const draft = buildDraft();
    const result = orderId ? await api(`/orders/${orderId}`, { method: "PUT", body: JSON.stringify({ ...draft, expectedRevision: revision }) }) : await api("/orders", { method: "POST", body: JSON.stringify(draft) });
    setOrderId(result.orderId);
    setRevision(result.revision);
    if (result.orderType) setOrderType(result.orderType);
    if (result.takeawayToken != null) setTakeawayToken(result.takeawayToken);
    setDirty(false);
    return result;
  };
  const ensureSaved = async () => orderId && !dirty ? { orderId, revision } : saveOrder();
  const saveAndReturn = async () => {
    try {
      setBusyAction("save");
      setBusy(true);
      await ensureSaved();
      show(orderType === "TAKEAWAY" ? "Takeaway order saved. It remains open." : "Staff changes saved. The DirectQR table bill remains open.");
      onBack();
    } catch (error) {
      show(error.message, "error");
    } finally {
      setBusy(false);
      setBusyAction("");
    }
  };
  const sendKot = async () => {
    let printWindow;
    try {
      printWindow = preparePrintWindow("Kitchen order ticket");
      setBusyAction("kot");
      setBusy(true);
      const saved = await ensureSaved();
      const result = await api(`/orders/${saved.orderId}/kot`, { method: "POST", body: JSON.stringify({ expectedRevision: saved.revision }) });
      setRevision(result.order.revision);
      setKotSequence(result.order.kot_sequence || result.kot.sequence);
      setOrderType(result.order.order_type || orderType);
      setTakeawayToken(result.order.takeaway_token ?? takeawayToken);
      writeKot(printWindow, result.order, result.kot);
      show(`KOT #${result.kot.dailyKotNumber || result.kot.sequence} opened for printing.`);
      onBack();
    } catch (error) {
      if (printWindow && !printWindow.closed) printWindow.close();
      show(error.message, "error");
    } finally {
      setBusy(false);
      setBusyAction("");
    }
  };
  const printBill = async () => {
    let printWindow;
    try {
      printWindow = preparePrintWindow("Customer bill");
      setBusyAction("bill");
      setBusy(true);
      const saved = await ensureSaved();
      const response = await api(`/orders/${saved.orderId}/bill/print`, { method: "POST", body: JSON.stringify({ expectedRevision: saved.revision, customerName, customerMobile }) });
      setRevision(response.order.revision);
      setBillLocked(true);
      setDirty(false);
      setOrderType(response.order.order_type || orderType);
      setTakeawayToken(response.order.takeaway_token ?? takeawayToken);
      writeBill(printWindow, response.order);
      show("Bill stored and opened for printing. Settle payment when it is received.");
      onBack();
    } catch (error) {
      if (printWindow && !printWindow.closed) printWindow.close();
      show(error.message, "error");
    } finally {
      setBusy(false);
      setBusyAction("");
    }
  };
  useEffect(() => {
    if (!quickAction || loading || busy) return;
    onQuickActionHandled?.();
    if (quickAction === "KOT") sendKot();
    else if (quickAction === "PRINT_BILL") printBill();
    else if (quickAction === "SETTLE") setSettlementOpen(true);
  }, [quickAction, loading, busy]);
  const reprintKot = async () => {
    let printWindow;
    try {
      printWindow = preparePrintWindow("KOT reprint");
      setBusyAction("reprint-kot");
      setBusy(true);
      const result = await api(`/orders/${orderId}/kot/reprint`, { method: "POST", body: JSON.stringify({}) });
      writeKot(printWindow, result.order, result.kot);
      show(`KOT #${result.kot.dailyKotNumber || result.kot.sequence} reprint opened.`);
    } catch (error) {
      if (printWindow && !printWindow.closed) printWindow.close();
      show(error.message, "error");
    } finally {
      setBusy(false);
      setBusyAction("");
    }
  };
  const settle = async (payments) => {
    try {
      setBusyAction("settle");
      setBusy(true);
      await api(`/orders/${orderId}/settle`, {
        method: "POST",
        body: JSON.stringify({ expectedRevision: revision, payments, printBill: false, customerName, customerMobile })
      });
      show("Order settled.");
      setSettlementOpen(false);
      onBack();
    } catch (error) {
      show(error.message, "error");
    } finally {
      setBusy(false);
      setBusyAction("");
    }
  };
  const voidOrder = async () => {
    if (!orderId) {
      const accepted = await confirm({ title: "Discard unsaved order?", message: "This new order has not been saved. It will be removed from this terminal only.", confirmLabel: "Discard order", tone: "danger" });
      if (accepted) onBack();
      return;
    }
    const confirmation = await requestForm({ title: "Void order", message: "Enter a reason and the shared outlet Void Password. This action is logged.", confirmLabel: "Void order", tone: "danger", fields: [{ name: "reason", label: "Void reason", type: "textarea", placeholder: "Why is this order being voided?", required: true, minLength: 3, maxLength: 250 }, { name: "voidPassword", label: "Void password", type: "password", placeholder: "Enter shared void password", required: true, minLength: 1, autoComplete: "off", help: "Set or reset this in Admin Settings." }] });
    if (!confirmation) return;
    let cancelWindow;
    try {
      const hasSentKot = kotSequence > 0 || cartDetails.some((entry) => Number(entry.snapshot?.sentToKitchenQty || 0) > 0);
      if (hasSentKot) cancelWindow = preparePrintWindow("Cancel kitchen order ticket");
      setBusyAction("void");
      setBusy(true);
      const saved = dirty ? await saveOrder() : { orderId, revision };
      const result = await api(`/orders/${saved.orderId}/void`, { method: "POST", body: JSON.stringify({ expectedRevision: saved.revision, reason: confirmation.reason, voidPassword: confirmation.voidPassword }) });
      if (result.cancelKots?.length) {
        writeCancelKot(cancelWindow, result.order, result.cancelKots);
        show("Open order voided. Cancel KOTs opened for printing.");
      } else {
        if (cancelWindow && !cancelWindow.closed) cancelWindow.close();
        show("Open order voided.");
      }
      onBack();
    } catch (error) {
      if (cancelWindow && !cancelWindow.closed) cancelWindow.close();
      show(error.message, "error");
    } finally {
      setBusy(false);
      setBusyAction("");
    }
  };
  const handleBack = async () => {
    if (!dirty) return onBack();
    const accepted = await confirm({ title: "Discard unsaved changes?", message: "Changes to this order have not been saved yet.", confirmLabel: "Discard changes", tone: "danger" });
    if (accepted) onBack();
  };

  if (loading) return <section className="order-page"><div className="empty">Loading order…</div></section>;

  const orderLocation = orderType === "TAKEAWAY" ? takeawayToken ? formatTakeawayToken(takeawayToken) : "New takeaway" : table?.name || "Table";
  const utilityDisabled = busy || billLocked || !canCreate;
  const activeUtility = (key) => setCartUtilityPanel((current) => current === key ? null : key);

  return <section className="order-page">
    <header className="order-header"><button className="back" onClick={handleBack}><Icon name="arrowLeft" size={16} />Back to QR orders</button><div><p className="eyebrow">{orderType === "TAKEAWAY" ? "TAKEAWAY" : "DIRECTQR TABLE ORDER"}</p><h1>{orderLocation} <span className="subtle">{billLocked ? "Bill printed · payment pending" : orderId ? "Open order" : "New order"}</span></h1></div>{canVoid && <button className="void-order-action" disabled={busy} onClick={voidOrder}><Icon name="trash" size={15} />Void order</button>}</header>
    <div className="order-layout">
      <section className={`menu-panel ${billLocked || !canCreate ? "menu-locked" : ""}`}>
        <div className="menu-search-wrap"><Icon name="search" size={17} /><input className="menu-search" value={menuSearch} onChange={(event) => setMenuSearch(event.target.value)} placeholder="Search all menu items" disabled={busy || billLocked || !canCreate} />{normalizedSearch && <span className="all-category-search">All categories</span>}</div>
        <div className="menu-browser">
          <nav className="category-bar category-rail" aria-label="Menu categories">{menu.categories.map((category) => <button key={category.id} className={`category ${categoryId === category.id && !normalizedSearch ? "active" : ""}`} onClick={() => { setCategoryId(category.id); setMenuSearch(""); }} disabled={busy || billLocked || !canCreate}><span>{category.name}</span><small className={`food-tag ${category.foodType === "NON_VEG" ? "nonveg" : "veg"}`}>{foodTypeLabel(category.foodType)}</small></button>)}</nav>
          <div className="menu-results"><div className="active-category-caption">{normalizedSearch ? <><Icon name="search" size={15} />Search results across all categories</> : activeCategory && <><span className={`food-tag ${activeCategory.foodType === "NON_VEG" ? "nonveg" : "veg"}`}>{foodTypeLabel(activeCategory.foodType)}</span>{activeCategory.name}</>}</div><div className="item-grid">{activeItems.map((item) => { const category = categoryById.get(item.categoryId); return <button className="menu-item" key={item.id} onClick={() => addItem(item)} disabled={busy || billLocked || !canCreate}><strong title={item.name}>{item.name}</strong>{normalizedSearch && category && <small className="item-category-label" title={category.name}>{category.name}</small>}{!normalizedSearch && <small>{gstRateLabel(item.gstRate)}</small>}{item.addonGroups.length > 0 && <em>Customise</em>}<span>{rupees(item.price)}</span></button>; })}{!activeItems.length && <div className="empty compact">{normalizedSearch ? "No menu item matches this search." : "No active items in this category."}</div>}</div></div>
        </div>
      </section>

      <aside className="cart-panel">
        <div className="cart-head"><div><h2>Cart Items</h2><span>{cartDetails.reduce((sum, item) => sum + item.quantity, 0)} item(s)</span></div><div className="cart-tools"><button className={cartUtilityPanel === "customer" ? "active" : ""} type="button" title="Customer details" aria-label="Toggle customer details" aria-pressed={cartUtilityPanel === "customer"} onClick={() => activeUtility("customer")}><Icon name="user" size={17} />{(customerName || customerMobile) && <i />}</button><button className={cartUtilityPanel === "note" ? "active" : ""} type="button" title="Order instruction" aria-label="Toggle order instruction" aria-pressed={cartUtilityPanel === "note"} onClick={() => activeUtility("note")}><Icon name="note" size={17} />{notes && <i />}</button></div></div>
        <div className="cart-scroll-area">
          {cartUtilityPanel === "customer" && <div className="cart-inline-panel"><div className="section-line"><div><strong>Customer details</strong><small>Optional · saved with the order and printed on the bill</small></div><button className="icon-button" type="button" title="Close customer details" onClick={() => setCartUtilityPanel(null)}><Icon name="close" size={15} /></button></div><div className="two-col"><label>Name<input value={customerName} maxLength="120" onChange={setOptionalValue(setCustomerName)} disabled={utilityDisabled} /></label><label>Mobile<input value={customerMobile} maxLength="32" onChange={setOptionalValue(setCustomerMobile)} disabled={utilityDisabled} /></label></div></div>}
          {cartUtilityPanel === "note" && <div className="cart-inline-panel"><div className="section-line"><div><strong>Order instruction</strong><small>Kitchen note for this order</small></div><button className="icon-button" type="button" title="Close order instruction" onClick={() => setCartUtilityPanel(null)}><Icon name="close" size={15} /></button></div><label className="notes-label"><textarea value={notes} placeholder="e.g. less sugar, no onion" maxLength="500" onChange={setOptionalValue(setNotes)} disabled={utilityDisabled} /></label></div>}
          <div className="cart-list">{cartDetails.map((entry, index) => <article className="cart-row cart-row-detailed" key={entry.localKey}><span className="cart-item-number">{index + 1}</span><div className="cart-item-copy"><strong title={entry.item.name}>{entry.item.name}</strong><small>{rupees(entry.item.price)} each · {gstRateLabel(entry.item.gstRate)}{entry.snapshot?.sentToKitchenQty ? ` · ${entry.snapshot.sentToKitchenQty} KOT sent` : ""}</small>{entry.addons.map((addon) => <div className="cart-addon" key={addon.id || addon.name}><span title={`${addon.name} × ${entry.quantity}`}>↳ {addon.name} × {entry.quantity}</span><span>{rupees(addon.price)} each · {rupees(Number(addon.price) * entry.quantity)}</span></div>)}</div><div className="qty"><button onClick={() => changeQty(entry.localKey, -1)} disabled={busy || billLocked || !canCreate || entry.quantity <= Number(entry.snapshot?.sentToKitchenQty || 0)}>−</button><span>{entry.quantity}</span><button onClick={() => changeQty(entry.localKey, 1)} disabled={busy || billLocked || !canCreate}>+</button></div><div className="cart-line-amount"><b>{rupees(entry.baseLineAmount + entry.addonLineAmount)}</b></div></article>)}{!cartDetails.length && <div className="empty cart-empty">Select items from the menu.</div>}</div>
          <div className="cart-controls"><div className="container-charge-row"><div><strong>Container charge</strong><small>Non-discountable · outlet GST {formatPercent(containerGstRate)}%</small></div><label className="money-input"><span>₹</span><input type="number" min="0" max="100000" step="0.01" inputMode="decimal" value={containerCharge} onChange={(event) => { setContainerCharge(event.target.value); setDirty(true); }} disabled={utilityDisabled} /></label></div><button type="button" className={`calculation-toggle ${calculationOpen ? "open" : ""}`} onClick={() => setCalculationOpen((open) => !open)} aria-expanded={calculationOpen}><span>Bill details {discountType ? "· discount applied" : ""}</span><Icon name={calculationOpen ? "chevronUp" : "chevronDown"} size={16} /></button>{calculationOpen && <div className="calculation-details">{canDiscount ? <div className="discount-row"><select value={discountType || ""} onChange={(event) => { setDiscountType(event.target.value || null); setDirty(true); }} disabled={busy || billLocked}><option value="">No discount</option><option value="PERCENT">Discount %</option><option value="FIXED">Discount ₹</option></select>{discountType && <input type="number" min="0" max={discountType === "PERCENT" ? 100 : undefined} step="0.01" value={discountValue} onChange={(event) => { setDiscountValue(event.target.value); setDirty(true); }} disabled={busy || billLocked} />}</div> : <small className="muted">Discount permission is not enabled for this account.</small>}<div className="total-line"><span>Items subtotal</span><b>{rupees(estimate.totals.subtotal)}</b></div>{discountType && <div className="total-line"><span>{discountLabel(discountType, discountValue)}</span><b>− {rupees(estimate.totals.discountAmount)}</b></div>}{Number(estimate.totals.containerCharge || 0) > 0 && <div className="total-line"><span>Container charge</span><b>{rupees(estimate.totals.containerCharge)}</b></div>}<div className="total-line"><span>{taxBreakupLabels(cartDetails).cgst}</span><b>{rupees(estimate.totals.cgstAmount)}</b></div><div className="total-line"><span>{taxBreakupLabels(cartDetails).sgst}</span><b>{rupees(estimate.totals.sgstAmount)}</b></div><div className="total-line"><span>Round off</span><b>{signedRupees(estimate.totals.roundOff)}</b></div></div>}</div>
        </div>
        <div className="cart-footer"><div className="grand-line"><span>Grand total</span><b>{rupees(estimate.totals.grandTotal)}</b></div>{billLocked ? <div className="order-actions"><div className="bill-pending-note">Bill printed. Cart is locked until payment is settled or the order is voided.</div>{canSettle && <button className="primary settle-action" disabled={busy} onClick={() => setSettlementOpen(true)}>{busyAction === "settle" ? "Settling…" : "Settle payment"}</button>}</div> : <div className="cart-actions order-actions">{canCreate && <button className="outline" disabled={busy || !cart.length} onClick={saveAndReturn}>{busyAction === "save" ? "Saving…" : "Save order"}</button>}{canSendKot && <button className="outline" disabled={busy || !cart.length} onClick={sendKot}>{busyAction === "kot" ? "Generating…" : "Print KOT"}</button>}{canPrintBill && <button className="primary settle-action" disabled={busy || !cart.length} onClick={printBill}>{busyAction === "bill" ? "Printing…" : "Print bill"}</button>}{orderId && kotSequence > 0 && canSendKot && <button className="text-button reprint-kot-action" disabled={busy} onClick={reprintKot}>{busyAction === "reprint-kot" ? "Opening…" : "Reprint last KOT"}</button>}</div>}</div>
      </aside>
    </div>
    {addonTarget && <AddonModal item={addonTarget} onClose={() => setAddonTarget(null)} onConfirm={addConfigured} />}
    {settlementOpen && <SettlementModal total={estimate.totals.grandTotal} onClose={() => setSettlementOpen(false)} onSettle={settle} busy={busy} />}
  </section>;
}

function AddonModal({ item, onClose, onConfirm }) {
  const [selected, setSelected] = useState([]);
  const groupSelections = (group) => selected.filter((id) => group.options.some((option) => option.id === id));
  const isValid = item.addonGroups.every((group) => {
    const count = groupSelections(group).length;
    return count >= Number(group.minSelect) && count <= Number(group.maxSelect);
  });
  const toggle = (group, option) => {
    setSelected((old) => {
      const exists = old.includes(option.id);
      const groupIds = old.filter((id) => group.options.some((groupOption) => groupOption.id === id));
      if (exists) return old.filter((id) => id !== option.id);
      if (groupIds.length >= Number(group.maxSelect)) return [...old.filter((id) => !groupIds.includes(id)), option.id];
      return [...old, option.id];
    });
  };
  const selectionHelp = (group) => {
    if (Number(group.minSelect) === Number(group.maxSelect)) return `Choose exactly ${group.minSelect}`;
    if (Number(group.minSelect) > 0) return `Choose ${group.minSelect}\u2013${group.maxSelect}`;
    return `Choose up to ${group.maxSelect}`;
  };
  return <Modal title={`Configure ${item.name}`} onClose={onClose}>
      <div className="addon-modal">
        {item.addonGroups.map((group) => <div className="addon-group" key={group.id}>
            <div><strong>{group.name}</strong><small>{selectionHelp(group)}</small></div>
            {group.options.map((option) => <label className="addon-option" key={option.id}>
                <input type="checkbox" checked={selected.includes(option.id)} onChange={() => toggle(group, option)} />
                <span>{option.name}</span><b>+ {rupees(option.price)}</b>
              </label>)}
          </div>)}
        {!isValid && <small className="bad">Complete all required add-on selections.</small>}
        <div className="modal-actions"><button className="outline" onClick={onClose}>Cancel</button><button className="primary" disabled={!isValid} onClick={() => onConfirm(item, selected)}>Add to order</button></div>
      </div>
    </Modal>;
}
function SettlementModal({ total, onClose, onSettle, busy }) {
  const paymentMethods = ["CASH", "UPI", "CARD"];
  const [payments, setPayments] = useState([{ method: "UPI", amount: Number(total).toFixed(2), reference: "" }]);
  const toPaymentPaise = (value) => {
    const amount = Number(value);
    return Number.isFinite(amount) && amount > 0 ? Math.round((amount + Number.EPSILON) * 100) : 0;
  };
  const totalPaise = Math.round((Number(total || 0) + Number.EPSILON) * 100);
  const paidPaise = payments.reduce((sum, payment) => sum + toPaymentPaise(payment.amount), 0);
  const matched = paidPaise === totalPaise;
  const positivePayments = payments.filter((payment) => toPaymentPaise(payment.amount) > 0);
  const usedMethods = new Set(payments.map((payment) => payment.method));
  const availableMethods = paymentMethods.filter((method) => !usedMethods.has(method));
  return <Modal title="Settle payment" onClose={onClose}><div className="payment-modal"><div className="payment-total"><span>Total payable</span><strong>{rupees(total)}</strong></div><p className="muted">The bill is already printed. Choose how this exact total was received.</p>{payments.map((payment, index) => <div className="payment-row" key={payment.method}><select value={payment.method} onChange={(event) => setPayments((old) => old.map((value, itemIndex) => itemIndex === index ? { ...value, method: event.target.value } : value))} disabled={busy}>{paymentMethods.map((method) => <option key={method} value={method} disabled={method !== payment.method && usedMethods.has(method)}>{method}</option>)}</select><input type="number" min="0" step="0.01" value={payment.amount} onChange={(event) => setPayments((old) => old.map((value, itemIndex) => itemIndex === index ? { ...value, amount: event.target.value } : value))} disabled={busy} />{payments.length > 1 && <button className="icon-button" onClick={() => setPayments((old) => old.filter((_, itemIndex) => itemIndex !== index))} disabled={busy}>×</button>}</div>)}{availableMethods.length > 0 && <button className="link-button" onClick={() => setPayments((old) => [...old, { method: availableMethods[0], amount: "0.00", reference: "" }])} disabled={busy}>+ Add split payment</button>}<small className="muted">Each payment method appears once. Combine same-method amounts in its row.</small><div className={`payment-match ${matched ? "good" : "bad"}`}>Received: {rupees(paidPaise / 100)} · {matched ? "Matched" : `Difference ${rupees((totalPaise - paidPaise) / 100)}`}</div><div className="modal-actions"><button className="outline" onClick={onClose} disabled={busy}>Cancel</button><button className="primary" disabled={busy || !matched || !positivePayments.length} onClick={() => onSettle(positivePayments)}>Save & settle</button></div></div></Modal>;
}
function ReportsView({ show, timezone, restaurantName, requestForm, canReprint, canCustomerDetails }) {
  const [from, setFrom] = useState(indiaToday());
  const [to, setTo] = useState(indiaToday());
  const [summary, setSummary] = useState(null);
  const [orders, setOrders] = useState([]);
  const [voidOrders, setVoidOrders] = useState([]);
  const [customers, setCustomers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [printingId, setPrintingId] = useState(null);
  const [reportType, setReportType] = useState("executive");
  const [search, setSearch] = useState("");
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = `?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
      const calls = [api(`/reports/executive${params}`), api(`/reports/sales${params}`), api(`/reports/voids${params}`)];
      if (canCustomerDetails) calls.push(api(`/reports/customers${params}`));
      const [executive, sales, voids, customerData] = await Promise.all(calls);
      setSummary(executive.summary);
      setOrders(sales.orders);
      setVoidOrders(voids.orders);
      setCustomers(customerData?.customers || []);
    } catch (error) {
      show(error.message, "error");
    } finally {
      setLoading(false);
    }
  }, [from, to, show, canCustomerDetails]);
  useEffect(() => {
    load();
  }, [load]);
  const filter = (value) => String(value || "").toLowerCase().includes(search.trim().toLowerCase());
  const filteredOrders = orders.filter((order) => !search || filter(order.orderNumber) || filter(orderLocationLabel(order)) || filter(paymentSummary(order)));
  const filteredVoids = voidOrders.filter((order) => !search || filter(order.orderNumber) || filter(order.tableName) || filter(order.reason));
  const filteredCustomers = customers.filter((customer) => !search || filter(customer.name) || filter(customer.mobile));
  const salesTotals = useMemo(() => filteredOrders.reduce((totals, order) => ({ subtotal: totals.subtotal + Number(order.subtotal || 0), discount: totals.discount + Number(order.discountAmount || 0), container: totals.container + Number(order.containerCharge || 0), gst: totals.gst + Number(order.gstAmount || 0), roundOff: totals.roundOff + Number(order.roundOff || 0), grandTotal: totals.grandTotal + Number(order.grandTotal || 0), cash: totals.cash + paymentAmount(order, "CASH"), upi: totals.upi + paymentAmount(order, "UPI"), card: totals.card + paymentAmount(order, "CARD") }), { subtotal: 0, discount: 0, container: 0, gst: 0, roundOff: 0, grandTotal: 0, cash: 0, upi: 0, card: 0 }), [filteredOrders]);
  const printExecutive = () => {
    const win = preparePrintWindow("Executive sales summary");
    writeExecutiveSalesReport(win, { restaurantName, from, to, summary });
  };
  const printSales = () => {
    const win = preparePrintWindow("Sales summary");
    writeSalesSummaryReport(win, { restaurantName, from, to, timezone, orders: filteredOrders, totals: salesTotals });
  };
  const printCustomers = () => {
    const win = preparePrintWindow("Customer details");
    const rows = filteredCustomers.map((c) => `<tr><td>${escapeHtml(c.name || "\u2014")}</td><td>${escapeHtml(c.mobile || "\u2014")}</td></tr>`).join("") || '<tr><td colspan="2" class="empty-row">No customer details for this period.</td></tr>';
    writeReportPrintDocument(win, "Customer details", `<section class="report-print"><header><p class="report-kicker">DIRECTQR</p><h1>Customer Details</h1><p>${escapeHtml(restaurantName)} \xB7 ${escapeHtml(from)} to ${escapeHtml(to)}</p></header><table><thead><tr><th>Customer Name</th><th>Mobile Number</th></tr></thead><tbody>${rows}</tbody></table></section>`);
  };
  const printVoids = () => {
    const win = preparePrintWindow("Void orders");
    const rows = filteredVoids.map((o) => `<tr><td>#${escapeHtml(o.orderNumber)}</td><td>${escapeHtml(o.tableName || "\u2014")}</td><td>${escapeHtml(formatTime(o.voidedAt, timezone))}</td><td>${escapeHtml(o.reason || "\u2014")}</td></tr>`).join("") || '<tr><td colspan="4" class="empty-row">No voided orders.</td></tr>';
    writeReportPrintDocument(win, "Void orders", `<section class="report-print"><header><p class="report-kicker">DIRECTQR</p><h1>Void Orders</h1><p>${escapeHtml(restaurantName)} \xB7 ${escapeHtml(from)} to ${escapeHtml(to)}</p></header><table><thead><tr><th>Order</th><th>Table</th><th>Voided at</th><th>Reason</th></tr></thead><tbody>${rows}</tbody></table></section>`);
  };
  const downloadExecutive = () => downloadCsv(`directqr-executive-sales-${from}-to-${to}.csv`, [["Metric", "Amount"], ["Orders", summary?.order_count ?? 0], ["Subtotal Sale", reportNumber(summary?.subtotal_sale)], ["Discounts", reportNumber(summary?.discount_total)], ["Container Charge", reportNumber(summary?.container_charge_total)], ["CGST", reportNumber(summary?.cgst_total)], ["SGST", reportNumber(summary?.sgst_total)], ["Total GST", reportNumber(summary?.total_gst)], ["Round Off", reportNumber(summary?.round_off_total)], ["Grand Sale", reportNumber(summary?.grand_sale)], ["Cash", reportNumber(summary?.cash_payment)], ["UPI", reportNumber(summary?.upi_payment)], ["Card", reportNumber(summary?.card_payment)]]);
  const downloadSales = () => downloadCsv(`directqr-sales-summary-${from}-to-${to}.csv`, [["Order", "Table / Token", "Time", "Subtotal", "Discount", "Container Charge", "GST", "Round Off", "Grand Total", "Cash", "UPI", "Card"], ...filteredOrders.map((o) => [`#${o.orderNumber}`, orderLocationLabel(o), formatTime(o.completedAt, timezone), reportNumber(o.subtotal), reportNumber(o.discountAmount), reportNumber(o.containerCharge), reportNumber(o.gstAmount), reportNumber(o.roundOff), reportNumber(o.grandTotal), reportNumber(paymentAmount(o, "CASH")), reportNumber(paymentAmount(o, "UPI")), reportNumber(paymentAmount(o, "CARD"))])]);
  const downloadVoids = () => downloadCsv(`directqr-void-orders-${from}-to-${to}.csv`, [["Order", "Table", "Voided at", "Reason"], ...filteredVoids.map((o) => [`#${o.orderNumber}`, o.tableName || "", formatTime(o.voidedAt, timezone), o.reason || ""])]);
  const downloadCustomers = () => downloadCsv(`directqr-customer-details-${from}-to-${to}.csv`, [["Customer Name", "Mobile Number"], ...filteredCustomers.map((c) => [c.name, c.mobile])]);
  const reprint = async (order) => {
    const confirmation = await requestForm({ title: `Reprint bill #${order.orderNumber}`, message: "Admin username and password are required.", confirmLabel: "Authorize reprint", fields: [{ name: "adminUsername", label: "Admin username", required: true, minLength: 3 }, { name: "adminPassword", label: "Admin password", type: "password", required: true, minLength: 1 }] });
    if (!confirmation) return;
    let win;
    try {
      win = preparePrintWindow("Bill reprint");
      setPrintingId(order.id);
      const { order: printed } = await api(`/orders/${order.id}/bill/reprint`, { method: "POST", body: JSON.stringify(confirmation) });
      writeBill(win, printed, { reprint: true });
      show("Bill reprint opened.");
    } catch (error) {
      if (win && !win.closed) win.close();
      show(error.message, "error");
    } finally {
      setPrintingId(null);
    }
  };
  const executiveMetrics = [["Orders", summary?.order_count], ["Subtotal sale", rupees(summary?.subtotal_sale)], ["Discounts", rupees(summary?.discount_total)], ["Container charge", rupees(summary?.container_charge_total)], ["GST collected", rupees(summary?.total_gst)], ["CGST", rupees(summary?.cgst_total)], ["SGST", rupees(summary?.sgst_total)], ["Round off", signedRupees(summary?.round_off_total)], ["Grand sale", rupees(summary?.grand_sale)], ["UPI", rupees(summary?.upi_payment)], ["Cash", rupees(summary?.cash_payment)], ["Card", rupees(summary?.card_payment)]];
  const cards = [["executive", "Executive sales summary"], ["sales", "Sales summary"], ["voids", "Void orders"], ...canCustomerDetails ? [["customers", "Customer details"]] : []];
  return <section className="page"><header className="page-header"><div><p className="eyebrow">BUSINESS INTELLIGENCE</p><h1>Reports</h1><p className="muted">Completed orders only. Reporting day uses {timezone}.</p></div><div className="date-filter"><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /><span>to</span><input type="date" value={to} onChange={(e) => setTo(e.target.value)} /><button className="outline" onClick={load}>Apply</button></div></header><div className="report-type-tabs report-type-cards">{cards.map(([key, label]) => <button key={key} className={reportType === key ? "active" : ""} onClick={() => setReportType(key)}>{label}</button>)}</div>{reportType !== "executive" && <input className="report-search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search this report" />}{loading ? <div className="empty">Loading report…</div> : <div className="report-stack">
  {reportType === "executive" && <section className="report-card"><div className="report-title"><div><h2>Executive Sales Summary</h2><span>{from} to {to}</span></div><div className="report-actions"><button className="outline" onClick={printExecutive}>Print</button><button className="primary" onClick={downloadExecutive}>Download CSV</button></div></div><div className="metric-grid report-metrics">{executiveMetrics.map(([label, value]) => <div className="metric" key={label}><span>{label}</span><strong>{value ?? "\u2014"}</strong></div>)}</div></section>}
  {reportType === "sales" && <section className="report-card"><div className="report-title"><div><h2>Sales Summary</h2><span>{filteredOrders.length} matching order(s)</span></div><div className="report-actions"><button className="outline" onClick={printSales}>Print</button><button className="primary" onClick={downloadSales}>Download CSV</button></div></div><div className="table-scroll"><table><thead><tr><th>Order</th><th>Table / token</th><th>Time</th><th className="right">Subtotal</th><th className="right">Discount</th><th className="right">Container</th><th className="right">GST</th><th className="right">Round off</th><th className="right">Grand total</th><th>Bill</th></tr></thead><tbody>{filteredOrders.map((o) => <tr key={o.id}><td>#{o.orderNumber}</td><td>{orderLocationLabel(o)}</td><td>{formatTime(o.completedAt, timezone)}</td><td className="right">{rupees(o.subtotal)}</td><td className="right">{rupees(o.discountAmount)}</td><td className="right">{rupees(o.containerCharge)}</td><td className="right">{rupees(o.gstAmount)}</td><td className="right">{signedRupees(o.roundOff)}</td><td className="right"><strong>{rupees(o.grandTotal)}</strong></td><td>{canReprint ? <button className="text-button" disabled={printingId === o.id} onClick={() => reprint(o)}>{printingId === o.id ? "Opening\u2026" : "Reprint"}</button> : "\u2014"}</td></tr>)}{!filteredOrders.length && <tr><td colSpan="10" className="empty">No completed orders found.</td></tr>}</tbody>{filteredOrders.length > 0 && <tfoot><tr><td colSpan="3"><strong>Total</strong></td><td className="right">{rupees(salesTotals.subtotal)}</td><td className="right">{rupees(salesTotals.discount)}</td><td className="right">{rupees(salesTotals.container)}</td><td className="right">{rupees(salesTotals.gst)}</td><td className="right">{signedRupees(salesTotals.roundOff)}</td><td className="right">{rupees(salesTotals.grandTotal)}</td><td /></tr></tfoot>}</table></div></section>}
  {reportType === "voids" && <section className="report-card"><div className="report-title"><div><h2>Void Orders</h2><span>{filteredVoids.length} matching order(s)</span></div><div className="report-actions"><button className="outline" onClick={printVoids}>Print</button><button className="primary" onClick={downloadVoids}>Download CSV</button></div></div><div className="table-scroll"><table><thead><tr><th>Order</th><th>Table</th><th>Voided at</th><th className="right">Value</th><th>KOT</th><th>Reason</th></tr></thead><tbody>{filteredVoids.map((o) => <tr key={o.id}><td>#{o.orderNumber}</td><td>{o.tableName || "\u2014"}</td><td>{formatTime(o.voidedAt, timezone)}</td><td className="right">{rupees(o.grandTotal)}</td><td>{o.kotSent ? "Sent" : "Not sent"}</td><td>{o.reason || "\u2014"}</td></tr>)}{!filteredVoids.length && <tr><td colSpan="6" className="empty">No voided orders found.</td></tr>}</tbody></table></div></section>}
  {reportType === "customers" && <details className="report-card customer-report"><summary className="report-title"><div><h2>Customer Details</h2><span>{filteredCustomers.length} unique name / mobile record(s)</span></div><b>⌄</b></summary><div className="report-actions report-actions-pad"><button className="outline" onClick={printCustomers}>Print</button><button className="primary" onClick={downloadCustomers}>Download CSV</button></div><div className="table-scroll"><table><thead><tr><th>Customer Name</th><th>Mobile Number</th></tr></thead><tbody>{filteredCustomers.map((c, index) => <tr key={`${c.name}-${c.mobile}-${index}`}><td>{c.name || "\u2014"}</td><td>{c.mobile || "\u2014"}</td></tr>)}{!filteredCustomers.length && <tr><td colSpan="2" className="empty">No customer details found.</td></tr>}</tbody></table></div></details>}
  </div>}</section>;
}
function SettingsView({ session, onSessionChange, show, confirm, requestForm, onEnableNotifications, notificationLabel = 'Enable mobile alerts' }) {
  const [settings, setSettings] = useState(null);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [gstinError, setGstinError] = useState("");
  const normalizeGstin = (value) => String(value || "").replace(/[\s-]+/g, "").toUpperCase();
  const validateGstin = (value) => {
    const normalized = normalizeGstin(value);
    if (!normalized) return "";
    if (normalized.length !== 15) return "GSTIN must contain exactly 15 characters after spaces and hyphens are removed.";
    if (!/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(normalized)) return "GSTIN format is invalid. Example: 09ABCDE1234F1Z5.";
    return "";
  };
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api("/settings");
      setSettings(data.settings);
    } catch (error) {
      show(error.message, "error");
    } finally {
      setLoading(false);
    }
  }, [show]);
  useEffect(() => {
    load();
  }, [load]);
  const saveSettings = async (event) => {
    event.preventDefault();
    const normalizedGstin = normalizeGstin(settings.gstin);
    const localGstinError = validateGstin(normalizedGstin);
    if (localGstinError) {
      setGstinError(localGstinError);
      show(`GSTIN was not saved: ${localGstinError}`, "error");
      return;
    }
    try {
      setSaving(true);
      const normalized = { ...settings, gstin: normalizedGstin };
      const data = await api("/settings", { method: "PUT", body: JSON.stringify(normalized) });
      setSettings(data.settings);
      setGstinError("");
      onSessionChange((previous) => ({ ...previous, restaurantName: data.settings.name, billPrefix: data.settings.billPrefix, themeColor: data.settings.themeColor, restaurantLoginId: data.settings.restaurantLoginId || previous.restaurantLoginId, openingTime: data.settings.openingTime, closingTime: data.settings.closingTime }));
      show("Caf\xE9 settings saved. Future bills and sales-hour groups use the new details.");
    } catch (error) {
      const fieldError = error.details?.find((detail) => detail.path === "gstin")?.message || (/GSTIN/i.test(error.message) ? error.message : "");
      if (fieldError) setGstinError(fieldError);
      show(fieldError ? `GSTIN was not saved: ${fieldError}` : error.message, "error");
    } finally {
      setSaving(false);
    }
  };
  const testNotification = async () => {
    try {
      const result = await api('/notifications/test', { method: 'POST', body: JSON.stringify({}) });
      if (Number(result?.sent || 0) > 0) show('Test notification sent to this device.');
      else show('No saved device subscription was found. Enable mobile alerts first.', 'error');
    } catch (error) {
      show(error.message, 'error');
    }
  };
  const resetVoidPassword = async () => {
    const values = await requestForm({ title: "Reset shared Void Password", message: "All staff will use this outlet-level password to void open orders. Confirm using your Admin password.", confirmLabel: "Reset Void Password", tone: "danger", fields: [{ name: "adminPassword", label: "Admin password", type: "password", required: true, minLength: 1, autoComplete: "off" }, { name: "newVoidPassword", label: "New Void Password", type: "password", required: true, minLength: 12, autoComplete: "off", help: "12+ characters with upper/lowercase, number and symbol." }] });
    if (!values) return;
    try {
      setSaving(true);
      await api("/settings/void-password", { method: "PUT", body: JSON.stringify(values) });
      show("Shared Void Password reset. Give it only to authorised staff.");
    } catch (error) {
      show(error.message, "error");
    } finally {
      setSaving(false);
    }
  };
  if (loading || !settings) return <section className="page"><div className="empty">Loading settings…</div></section>;
  return <section className="page"><header className="page-header"><div><p className="eyebrow">OUTLET CONFIGURATION</p><h1>Settings</h1><p className="muted">Business details apply to future bills. Existing bill snapshots remain unchanged.</p></div></header><div className="settings-layout"><section className="report-card settings-card"><div className="report-title"><h2>Café identity, billing & timings</h2></div><form className="settings-form" onSubmit={saveSettings}><label>Restaurant ID<input value={settings.restaurantLoginId || session.restaurantLoginId || ""} readOnly spellCheck={false} title="DirectQR-generated ID used for sign in" /></label><label>Café name<input value={settings.name} onChange={(event) => setSettings((old) => ({ ...old, name: event.target.value }))} required /></label><div className="two-col"><label>GSTIN<input value={settings.gstin} autoCapitalize="characters" spellCheck={false} maxLength="20" aria-invalid={Boolean(gstinError)} aria-describedby={gstinError ? "gstin-validation" : undefined} onBlur={(event) => setGstinError(validateGstin(event.target.value))} onChange={(event) => { const value = event.target.value.toUpperCase(); setSettings((old) => ({ ...old, gstin: value })); setGstinError(validateGstin(value)); }} />{gstinError && <small className="field-error" id="gstin-validation" role="alert">{gstinError}</small>}</label><label>Bill prefix<input value={settings.billPrefix} onChange={(event) => setSettings((old) => ({ ...old, billPrefix: event.target.value.toUpperCase() }))} required /></label></div><div className="two-col"><label>Opening time<input type="time" value={settings.openingTime || "09:00"} onChange={(event) => setSettings((old) => ({ ...old, openingTime: event.target.value }))} required /></label><label>Closing time<input type="time" value={settings.closingTime || "22:00"} onChange={(event) => setSettings((old) => ({ ...old, closingTime: event.target.value }))} required /></label></div><div className="two-col"><label>Container charge GST %<input type="number" min="0" max="100" step="0.01" value={settings.containerChargeGstRate ?? 5} onChange={(event) => setSettings((old) => ({ ...old, containerChargeGstRate: event.target.value }))} required /></label><div className="settings-inline-help"><strong>Outlet default</strong><span>Applied to new manual container charges before GST and round-off.</span></div></div><p className="form-help">Owner Dashboard groups sales in 3-hour blocks within these normal outlet hours.</p><div className="two-col"><label>Phone<input value={settings.phone} onChange={(event) => setSettings((old) => ({ ...old, phone: event.target.value }))} /></label><label>Timezone<input value={settings.timezone} readOnly title="Timezone is fixed in V1" /></label></div><label>Address<textarea value={settings.address} onChange={(event) => setSettings((old) => ({ ...old, address: event.target.value }))} /></label><div className="modal-actions"><button className="primary" disabled={saving}>{saving ? "Saving\u2026" : "Save settings"}</button></div></form></section><section className="report-card settings-card void-password-card"><div className="report-title"><div><h2>Shared Void Password</h2><span>Required from every user before an open order can be voided.</span></div></div><div className="settings-pad"><p className="muted">Keep this different from Admin and Staff credentials. Resetting it takes effect immediately for every terminal.</p><button className="outline" disabled={saving} onClick={resetVoidPassword}>Reset Void Password</button></div></section><section className="report-card settings-card notification-settings-card"><div className="report-title"><div><h2>Order Alerts</h2><span>Looping sound is enabled from Live QR Orders. Browser alerts need permission on each staff device.</span></div></div><div className="settings-pad"><p className="muted">Current device: <strong>{notificationLabel}</strong>. For iPhone/iPad, install DirectQR to the Home Screen before enabling alerts.</p><div className="settings-inline-actions"><button className="outline" onClick={onEnableNotifications}>{notificationLabel}</button><button className="primary" onClick={testNotification}>Test notification</button></div></div></section><StaffManagement timezone={session.timezone || "Asia/Kolkata"} show={show} confirm={confirm} requestForm={requestForm} /></div></section>;
}
function StaffManagement({ timezone, show, confirm, requestForm }) {
  const [staff, setStaff] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState(null);
  const [editor, setEditor] = useState(null);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api("/staff");
      setStaff(data.staff || []);
    } catch (error) {
      show(error.message, "error");
    } finally {
      setLoading(false);
    }
  }, [show]);
  useEffect(() => {
    load();
  }, [load]);
  const saveStaff = async (payload) => {
    try {
      setBusyId(payload.id || "create");
      if (payload.id) await api(`/staff/${payload.id}`, { method: "PUT", body: JSON.stringify(payload) });
      else await api("/staff", { method: "POST", body: JSON.stringify(payload) });
      show(payload.id ? "Staff account updated." : "Staff account created.");
      setEditor(null);
      load();
    } catch (error) {
      show(error.message, "error");
    } finally {
      setBusyId(null);
    }
  };
  const resetPassword = async (member) => {
    const details = await requestForm({ title: `Reset password: ${member.displayName}`, message: "Enter your Admin password to approve this reset.", confirmLabel: "Reset password", tone: "danger", fields: [{ name: "adminPassword", label: "Admin password", type: "password", required: true, minLength: 1 }, { name: "password", label: "New strong password", type: "password", required: true, minLength: 12, help: "12+ characters with upper/lowercase, number and symbol." }] });
    if (!details) return;
    try {
      setBusyId(member.id);
      await api(`/staff/${member.id}/reset-password`, { method: "POST", body: JSON.stringify(details) });
      show("Staff password reset. Active sessions were revoked.");
    } catch (error) {
      show(error.message, "error");
    } finally {
      setBusyId(null);
    }
  };
  const toggleStaff = async (member) => {
    const next = !member.isActive;
    const accepted = await confirm({ title: `${next ? "Reactivate" : "Deactivate"} ${member.displayName}?`, message: next ? "This staff member can sign in again." : "This signs the staff member out everywhere.", confirmLabel: next ? "Reactivate" : "Deactivate", tone: next ? void 0 : "danger" });
    if (!accepted) return;
    await saveStaff({ ...member, isActive: next });
  };
  return <section className="report-card settings-card staff-management-card"><div className="report-title"><div><h2>Staff accounts</h2><span>{staff.filter((x) => x.isActive).length} active · {staff.length} total</span></div><button className="primary compact-button" onClick={() => setEditor({ displayName: "", username: "", password: "", role: "CASHIER", permissions: ROLE_TEMPLATES.CASHIER, isActive: true })}>+ Add staff</button></div>{loading ? <div className="empty compact">Loading staff accounts…</div> : <div className="table-scroll"><table><thead><tr><th>Staff</th><th>Role</th><th>Status</th><th>Last login</th><th>Actions</th></tr></thead><tbody>{staff.map((member) => {
    const locked = member.lockedUntil && new Date(member.lockedUntil).getTime() > Date.now();
    const status = !member.isActive ? "Deactivated" : member.passwordResetRequired ? "Reset required" : locked ? "Temporarily locked" : "Active";
    return <tr key={member.id}><td><strong>{member.displayName}</strong><br /><small>{member.username}</small></td><td>{roleLabel(member.role)}</td><td>{status}</td><td>{member.lastLoginAt ? formatTime(member.lastLoginAt, timezone) : "Never"}</td><td className="staff-actions"><button className="text-button" onClick={() => setEditor({ ...member, password: "" })}>Edit</button><button className="text-button" disabled={busyId === member.id} onClick={() => resetPassword(member)}>Reset password</button><button className={`text-button ${member.isActive ? "danger" : ""}`} disabled={busyId === member.id} onClick={() => toggleStaff(member)}>{member.isActive ? "Deactivate" : "Reactivate"}</button></td></tr>;
  })}{!staff.length && <tr><td colSpan="5" className="empty">No staff accounts yet.</td></tr>}</tbody></table></div>}{editor && <StaffEditorModal staff={editor} onClose={() => setEditor(null)} onSave={saveStaff} busy={busyId === editor.id || busyId === "create"} />}</section>;
}
function StaffEditorModal({ staff, onClose, onSave, busy }) {
  const [form, setForm] = useState(() => ({ ...staff, permissions: { ...staff.permissions || ROLE_TEMPLATES[staff.role] || ROLE_TEMPLATES.CASHIER } }));
  const set = (key, value) => setForm((old) => ({ ...old, [key]: value }));
  const setRole = (role) => setForm((old) => ({ ...old, role, permissions: { ...ROLE_TEMPLATES[role] } }));
  const submit = (e) => {
    e.preventDefault();
    const body = { displayName: form.displayName, username: form.username, role: form.role, permissions: form.permissions, isActive: Boolean(form.isActive) };
    if (!form.id) body.password = form.password;
    else body.id = form.id;
    onSave(body);
  };
  return <Modal title={form.id ? `Edit ${form.displayName}` : "Create staff account"} onClose={onClose} variant="mobile-form-modal"><form className="staff-editor-form" onSubmit={submit}><label>Staff name<input value={form.displayName} onChange={(e) => set("displayName", e.target.value)} required /></label><label>Username<input value={form.username} onChange={(e) => set("username", e.target.value)} required /></label>{!form.id && <label>Strong password<input type="password" value={form.password} onChange={(e) => set("password", e.target.value)} minLength="12" required autoComplete="new-password" /></label>}<label>Role<select value={form.role} onChange={(e) => setRole(e.target.value)}><option value="WAITER">Waiter</option><option value="CASHIER">Cashier</option><option value="MANAGER">Manager</option></select></label><fieldset className="permission-toggles"><legend>Permissions</legend>{Object.entries(PERMISSION_LABELS).map(([key, label]) => <label className="toggle-row" key={key}><span>{label}</span><input type="checkbox" checked={Boolean(form.permissions[key])} onChange={(e) => set("permissions", { ...form.permissions, [key]: e.target.checked })} /></label>)}</fieldset><label className="toggle-row"><span>Account active</span><input type="checkbox" checked={Boolean(form.isActive)} onChange={(e) => set("isActive", e.target.checked)} /></label><div className="modal-actions"><button type="button" className="outline" onClick={onClose}>Cancel</button><button className="primary" disabled={busy}>{busy ? "Saving\u2026" : "Save staff"}</button></div></form></Modal>;
}
function MenuView({ show, canManage }) {
  const [menu, setMenu] = useState({ categories: [], items: [] });
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState(null);
  const [search, setSearch] = useState("");
  const load = useCallback(async () => {
    try {
      setLoading(true);
      setMenu(await api("/menu?includeInactive=true"));
    } catch (error) {
      show(error.message, "error");
    } finally {
      setLoading(false);
    }
  }, [show]);
  useEffect(() => { load(); }, [load]);
  const matching = (item) => item.name.toLowerCase().includes(search.trim().toLowerCase());
  const deleteCategory = async (category) => {
    if (!window.confirm(`Deactivate ${category.name}? Categories with active menu items cannot be deleted.`)) return;
    try {
      await api(`/categories/${category.id}`, { method: "DELETE" });
      show("Category deleted.");
      await load();
    } catch (error) { show(error.message, "error"); }
  };

  return <section className="page">
    <header className="page-header"><div><p className="eyebrow">CATALOGUE</p><h1>Menu Management</h1><p className="muted">Availability is controlled only from the item editor. Historical bill records are never changed.</p></div>{canManage && <div className="header-actions"><button className="outline" onClick={() => setModal({ type: "category" })}>+ Category</button><button className="primary" onClick={() => setModal({ type: "item" })}>+ Menu item</button></div>}</header>
    <input className="menu-admin-search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search menu items" />
    {loading ? <div className="empty">Loading menu…</div> : <div className="menu-admin">{menu.categories.map((category) => {
      const categoryItems = menu.items.filter((item) => item.categoryId === category.id && matching(item));
      return <details className="admin-category" key={category.id} open><summary className="admin-category-head"><div className="category-admin-title"><h2>{category.name}</h2><span className={`food-tag ${category.foodType === "NON_VEG" ? "nonveg" : "veg"}`}>{foodTypeLabel(category.foodType)}</span></div><div className="category-admin-actions"><span>{categoryItems.length} shown</span>{canManage && category.isActive && <button type="button" className="category-delete-button" title={`Delete ${category.name}`} aria-label={`Delete ${category.name}`} onClick={(event) => { event.preventDefault(); event.stopPropagation(); deleteCategory(category); }}><Icon name="trash" size={16} /></button>}<Icon name="chevronDown" size={17} className="admin-category-chevron" /></div></summary><div className="category-detail-body">{categoryItems.map((item) => <article className={`admin-item ${item.availability?.toLowerCase()}`} key={item.id}><div><strong title={item.name}>{item.name}</strong><span>{rupees(item.price)} + {item.gstRate}% GST · {String(item.availability || "AVAILABLE").replaceAll("_", " ")}</span>{item.addonGroups.length > 0 && <small>Add-ons: {item.addonGroups.flatMap((group) => group.options).map((option) => `${option.name} (${rupees(option.price)})`).join(", ")}</small>}</div>{canManage && <div className="item-actions"><button className="text-button" onClick={() => setModal({ type: "item", item })}>Edit</button></div>}</article>)}</div></details>;
    })}</div>}
    {modal?.type === "category" && <CategoryModal onClose={() => setModal(null)} onSaved={() => { setModal(null); load(); }} show={show} />}
    {modal?.type === "item" && <MenuItemModal menu={menu} item={modal.item} onClose={() => setModal(null)} onSaved={() => { setModal(null); load(); }} show={show} />}
  </section>;
}

function CategoryModal({ onClose, onSaved, show }) {
  const [name, setName] = useState("");
  const [foodType, setFoodType] = useState("VEG");
  const submit = async (event) => {
    event.preventDefault();
    try {
      await api("/categories", { method: "POST", body: JSON.stringify({ name, foodType, position: 0 }) });
      show("Category created.");
      onSaved();
    } catch (error) {
      show(error.message, "error");
    }
  };
  return <Modal title="Add category" onClose={onClose}><form onSubmit={submit}><label>Category name<input autoFocus value={name} onChange={(event) => setName(event.target.value)} required /></label><label>Category type<select value={foodType} onChange={(event) => setFoodType(event.target.value)}><option value="VEG">Vegetarian</option><option value="NON_VEG">Non-vegetarian</option></select></label><div className="modal-actions"><button className="outline" type="button" onClick={onClose}>Cancel</button><button className="primary">Save category</button></div></form></Modal>;
}
function MenuItemModal({ menu, item, onClose, onSaved, show }) {
  const initialAddons = (item?.addonGroups || []).flatMap((group) => group.options || []).map((option) => ({ name: option.name, price: option.price }));
  const [form, setForm] = useState(item ? {
    categoryId: item.categoryId,
    name: item.name,
    description: item.description || "",
    price: item.price,
    gstRate: item.gstRate,
    // Existing inactive items can be restored safely by choosing one of the
    // supported selling states; the standalone deactivate action remains the
    // only path that removes an item from ordering.
    availability: item.availability === "INACTIVE" ? "OUT_OF_STOCK" : item.availability || "AVAILABLE",
    addons: initialAddons
  } : { categoryId: menu.categories[0]?.id || "", name: "", description: "", price: "", gstRate: 5, availability: "AVAILABLE", addons: [] });
  const [formError, setFormError] = useState("");
  const set = (key, value) => {
    setForm((old) => ({ ...old, [key]: value }));
    setFormError("");
  };
  const save = async (event) => {
    event.preventDefault();
    const trimmedName = String(form.name || "").trim();
    const price = Number(form.price);
    const invalidAddon = form.addons.find((addon) => addon.name.trim() && (!Number.isFinite(Number(addon.price)) || Number(addon.price) < 0));
    if (!form.categoryId) {
      setFormError("Choose a valid category before saving this menu item.");
      return;
    }
    if (!trimmedName) {
      setFormError("Menu item name is required.");
      return;
    }
    if (!Number.isFinite(price) || price < 0) {
      setFormError("Base price must be a valid amount of ₹0 or more.");
      return;
    }
    if (invalidAddon) {
      setFormError(`Add-on “${invalidAddon.name.trim()}” needs a valid extra price.`);
      return;
    }
    const addons = form.addons
      .filter((addon) => addon.name.trim())
      .map((addon) => ({ name: addon.name.trim(), price: Number(addon.price || 0) }));
    const addonGroups = addons.length ? [{ name: "Add-ons", minSelect: 0, maxSelect: addons.length, options: addons }] : [];
    try {
      await api(item ? `/menu-items/${item.id}` : "/menu-items", {
        method: item ? "PUT" : "POST",
        body: JSON.stringify({
          categoryId: form.categoryId,
          name: trimmedName,
          description: String(form.description || "").trim(),
          price,
          gstRate: Number(form.gstRate),
          gstInclusive: false,
          availability: form.availability,
          addonGroups
        })
      });
      show(item ? "Menu item updated." : "Menu item created.");
      onSaved();
    } catch (error) {
      const message = error.details?.[0]?.message || error.message;
      setFormError(message);
      show(message, "error");
    }
  };
  return <Modal title={item ? "Edit menu item" : "Add menu item"} onClose={onClose} variant="mobile-form-modal"><form onSubmit={save} className="item-form"><label>Category<select value={form.categoryId} onChange={(event) => set("categoryId", event.target.value)}>{menu.categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select></label><label>Item name<input value={form.name} onChange={(event) => set("name", event.target.value)} required /></label><label>Item description <small className="form-help">Optional · shown to customers in DirectQR</small><textarea value={form.description} maxLength={300} onChange={(event) => set("description", event.target.value)} placeholder="Short description for the customer menu" /></label><div className="two-col"><label>Base price (₹)<input type="number" min="0" step="0.01" value={form.price} onChange={(event) => set("price", event.target.value)} required /></label><label>GST rate<select value={form.gstRate} onChange={(event) => set("gstRate", Number(event.target.value))}>{[0, 5, 12, 18, 28].map((rate) => <option key={rate} value={rate}>{rate}%</option>)}</select></label></div><label>Availability<select value={form.availability} onChange={(event) => set("availability", event.target.value)}><option value="AVAILABLE">Available</option><option value="OUT_OF_STOCK">Out of stock</option></select></label><div className="form-section simple-addon-editor"><div className="section-line"><div><strong>Add-ons</strong><small>Optional extras for this item.</small></div><button type="button" className="text-button" onClick={() => { setForm((old) => ({ ...old, addons: [...old.addons, { name: "", price: 0 }] })); setFormError(""); }}>+ Add add-on</button></div>{!form.addons.length && <div className="empty compact">No add-ons.</div>}{form.addons.map((addon, index) => <div className="simple-addon-row" key={index}><input placeholder="Add-on name" value={addon.name} onChange={(event) => setForm((old) => { const addons = [...old.addons]; addons[index] = { ...addons[index], name: event.target.value }; return { ...old, addons }; })} /><input type="number" min="0" step="0.01" placeholder="Extra price" value={addon.price} onChange={(event) => setForm((old) => { const addons = [...old.addons]; addons[index] = { ...addons[index], price: event.target.value }; return { ...old, addons }; })} /><button type="button" className="icon-button" onClick={() => { setForm((old) => ({ ...old, addons: old.addons.filter((_, itemIndex) => itemIndex !== index) })); setFormError(""); }}>×</button></div>)}</div>{formError && <div className="form-alert" role="alert">{formError}</div>}<div className="modal-actions"><button type="button" className="outline" onClick={onClose}>Cancel</button><button className="primary">Save item</button></div></form></Modal>;
}

function Modal({ title, onClose, children, variant = "" }) {
  return <div className="modal-backdrop" role="presentation" onMouseDown={onClose}><div className={`modal ${variant}`.trim()} role="dialog" aria-modal="true" aria-label={title} onMouseDown={(event) => event.stopPropagation()}><div className="modal-head"><h2>{title}</h2><button className="icon-button" onClick={onClose}>×</button></div>{children}</div></div>;
}
function formatTime(value, timezone) {
  if (!value) return "\u2014";
  return new Intl.DateTimeFormat("en-IN", { timeZone: timezone, hour: "2-digit", minute: "2-digit", day: "2-digit", month: "short" }).format(new Date(value));
}
function preparePrintWindow(title) {
  const win = window.open("", "_blank", "width=430,height=720");
  if (!win) throw new Error("Popup blocked. Allow popups for this POS before printing.");
  win.document.write(`<!doctype html><title>${escapeHtml(title)}</title><p style="font-family:Arial;padding:16px">Preparing print\u2026</p>`);
  return win;
}
function kotItemRows(items) {
  return items.map((item, index) => {
    const addonRows = (item.addons || []).map((addon) => `<br><small>\u21B3 ${escapeHtml(addon.name)} \xD7 ${item.quantity}</small>`).join("");
    return `<tr><td class="serial">${index + 1}</td><td><strong>${escapeHtml(item.itemName)}</strong>${addonRows}</td><td class="right">${item.quantity}</td></tr>`;
  }).join("");
}
function kotTable(items) {
  return `<table class="line-table"><thead><tr><th class="serial">No.</th><th>Item</th><th class="right">Quantity</th></tr></thead><tbody>${kotItemRows(items)}</tbody></table>`;
}
function writeKot(win, order, kot) {
  const reprint = Boolean(kot.isReprint);
  const label = reprint ? "KOT REPRINT" : "KITCHEN ORDER TICKET";
  const notice = reprint ? '<p class="notice">REPRINT — use this only if the earlier KOT was not received.</p>' : "";
  const number = kot.dailyKotNumber || kot.sequence;
  const location = orderLocationLabel(order);
  writePrintDocument(win, `KOT #${number}`, `<div class="ticket kot-ticket"><h1>${escapeHtml(order.restaurant_name)}</h1><h2>${label}</h2><div class="meta">Order #${order.order_number} · ${escapeHtml(location)}<br>KOT #${number} · ${formatTime(kot.printedAt, "Asia/Kolkata")}</div>${notice}<hr>${kotTable(kot.items)}<hr>${order.notes ? `<p><strong>Note:</strong> ${escapeHtml(order.notes)}</p>` : ""}<p class="footer">DirectQR</p></div>`);
}

function writeCancelKot(win, order, cancelKots) {
  const location = orderLocationLabel(order);
  const sections = (cancelKots || []).map((cancelKot) => `<section class="cancel-kot-section"><h2>CANCEL KOT #${cancelKot.dailyKotNumber || cancelKot.sequence}</h2><div class="meta">VOIDED ORDER #${order.order_number} · ${escapeHtml(location)}<br>${formatTime(cancelKot.printedAt, "Asia/Kolkata")}</div><p class="notice cancel">CANCELLED — DO NOT PREPARE / STOP PREPARATION</p>${kotTable(cancelKot.items)}</section>`).join("<hr>");
  writePrintDocument(win, `Cancel KOT ${order.order_number}`, `<div class="ticket kot-ticket"><h1>${escapeHtml(order.restaurant_name)}</h1>${sections}<hr><p><strong>Void reason:</strong> ${escapeHtml(order.void_reason || "Order voided")}</p><p class="footer">DirectQR</p></div>`);
}

function billTaxLabels(order) {
  return taxBreakupLabels((order.items || []).map((item) => ({ gst_rate: item.gst_rate })));
}
function writeBill(win, order, options = {}) {
  const taxLabels = billTaxLabels(order);
  const isPending = order.status === "OPEN";
  const itemRows = order.items.map((item, index) => {
    const quantity = Number(item.quantity);
    const unit = Number(item.unit_price);
    const amount = unit * quantity;
    const addonRows = (item.addons_snapshot || []).map((addon) => {
      const addonQty = quantity;
      const addonPrice = Number(addon.price);
      return `<tr class="addon-line"><td></td><td>↳ ${escapeHtml(addon.name)}</td><td class="right">${addonQty}</td><td class="right">${rupees(addonPrice)}</td><td class="right">${rupees(addonQty * addonPrice)}</td></tr>`;
    }).join("");
    return `<tr><td class="serial">${index + 1}</td><td><strong>${escapeHtml(item.item_name)}</strong></td><td class="right">${quantity}</td><td class="right">${rupees(unit)}</td><td class="right">${rupees(amount)}</td></tr>${addonRows}`;
  }).join("");
  const totalQty = order.items.reduce((sum, item) => sum + Number(item.quantity || 0), 0);
  const discountLine = order.discount_type ? `<div class="bill-line"><span>${escapeHtml(discountLabel(order.discount_type, order.discount_value))}</span><b>− ${rupees(order.discount_amount)}</b></div>` : "";
  const containerLine = Number(order.container_charge || 0) > 0 ? `<div class="bill-line"><span>Container charge</span><b>${rupees(order.container_charge)}</b></div>` : "";
  const payments = (order.payments || []).map((payment) => `${escapeHtml(payment.method)} ${rupees(payment.amount)}`).join(" · ") || (isPending ? "PAYMENT PENDING" : "—");
  const title = options.reprint ? "BILL · REPRINT" : isPending ? "BILL · PAYMENT PENDING" : "TAX INVOICE";
  const customer = `${order.customer_name ? `<p class="customer-line"><strong>Name:</strong> ${escapeHtml(order.customer_name)}</p>` : ""}${order.customer_mobile ? `<p class="customer-line"><strong>Mobile:</strong> ${escapeHtml(order.customer_mobile)}</p>` : ""}`;
  const billTime = order.completed_at || order.bill_print_requested_at || new Date().toISOString();
  const locationLabel = order.order_type === "TAKEAWAY" ? "Takeaway" : "Dine In";
  const meta = `<div class="bill-meta-grid"><span>Date: ${formatTime(billTime, "Asia/Kolkata")}</span><span>${locationLabel}: ${escapeHtml(orderLocationLabel(order))}</span><span>Cashier: ${escapeHtml(order.completed_by_name || "—")}</span><span>Bill No.: ${escapeHtml(order.bill_prefix)}-${order.order_number}</span></div>`;
  const table = `<table class="line-table bill-items"><thead><tr><th class="serial">No.</th><th>Item</th><th class="right">Qty.</th><th class="right">Price</th><th class="right">Amount</th></tr></thead><tbody>${itemRows}</tbody></table>`;
  const body = `<div class="ticket bill-ticket"><h1>${escapeHtml(order.restaurant_name)}</h1>${order.address ? `<p class="center">${escapeHtml(order.address)}</p>` : ""}${order.phone ? `<p class="center">PH NO: ${escapeHtml(order.phone)}</p>` : ""}${order.gstin ? `<p class="center">GSTIN NO: ${escapeHtml(order.gstin)}</p>` : ""}<h2>${title}</h2><hr>${customer}${meta}<hr>${table}<hr><div class="bill-line"><span>Total Qty: ${totalQty}</span><b>Subtotal ${rupees(order.subtotal)}</b></div>${discountLine}${containerLine}<div class="bill-line"><span>SGST ${escapeHtml(taxLabels.sgst.replace("SGST @ ", ""))}</span><b>${rupees(order.sgst_amount)}</b></div><div class="bill-line"><span>CGST ${escapeHtml(taxLabels.cgst.replace("CGST @ ", ""))}</span><b>${rupees(order.cgst_amount)}</b></div><div class="bill-line"><span>Round off</span><b>${signedRupees(order.round_off)}</b></div><div class="bill-line total"><span>Grand Total</span><b>${rupees(order.grand_total)}</b></div><div class="payment-line">Payment: ${payments}</div><hr><p class="footer">Thanks, visit again.</p></div>`;
  writePrintDocument(win, `Bill ${order.order_number}`, body);
}

function writeExecutiveSalesReport(win, { restaurantName, from, to, summary }) {
  const rows = [
    ["Orders", String(summary?.order_count ?? 0)],
    ["Subtotal sale", rupees(summary?.subtotal_sale)],
    ["Discounts", rupees(summary?.discount_total)],
    ["Container charge", rupees(summary?.container_charge_total)],
    ["CGST", rupees(summary?.cgst_total)],
    ["SGST", rupees(summary?.sgst_total)],
    ["GST collected", rupees(summary?.total_gst)],
    ["Round off", signedRupees(summary?.round_off_total)],
    ["Grand sale", rupees(summary?.grand_sale)],
    ["Cash payment", rupees(summary?.cash_payment)],
    ["UPI payment", rupees(summary?.upi_payment)],
    ["Card payment", rupees(summary?.card_payment)]
  ];
  const body = `<section class="report-print"><header><p class="report-kicker">DIRECTQR</p><h1>Executive Sales Summary</h1><p>${escapeHtml(restaurantName)} · ${escapeHtml(from)} to ${escapeHtml(to)}</p></header><table><thead><tr><th>Metric</th><th class="right">Amount</th></tr></thead><tbody>${rows.map(([label, amount]) => `<tr><td>${escapeHtml(label)}</td><td class="right">${escapeHtml(amount)}</td></tr>`).join("")}</tbody></table><footer>Generated by DirectQR</footer></section>`;
  writeReportPrintDocument(win, "Executive sales summary", body);
}

function writeSalesSummaryReport(win, { restaurantName, from, to, timezone, orders, totals }) {
  const rows = orders.map((order) => `<tr><td>#${escapeHtml(order.orderNumber)}</td><td>${escapeHtml(orderLocationLabel(order))}</td><td>${escapeHtml(formatTime(order.completedAt, timezone))}</td><td class="right">${rupees(order.subtotal)}</td><td class="right">${rupees(order.discountAmount)}</td><td class="right">${rupees(order.containerCharge)}</td><td class="right">${rupees(order.gstAmount)}</td><td class="right">${signedRupees(order.roundOff)}</td><td class="right"><strong>${rupees(order.grandTotal)}</strong></td><td class="right">${rupees(paymentAmount(order, "CASH"))}</td><td class="right">${rupees(paymentAmount(order, "UPI"))}</td><td class="right">${rupees(paymentAmount(order, "CARD"))}</td></tr>`).join("") || '<tr><td colspan="12" class="empty-row">No completed orders in this period.</td></tr>';
  const footer = orders.length ? `<tfoot><tr><td colspan="3"><strong>Total · ${orders.length} order${orders.length !== 1 ? "s" : ""}</strong></td><td class="right"><strong>${rupees(totals.subtotal)}</strong></td><td class="right"><strong>${rupees(totals.discount)}</strong></td><td class="right"><strong>${rupees(totals.container)}</strong></td><td class="right"><strong>${rupees(totals.gst)}</strong></td><td class="right"><strong>${signedRupees(totals.roundOff)}</strong></td><td class="right"><strong>${rupees(totals.grandTotal)}</strong></td><td class="right"><strong>${rupees(totals.cash)}</strong></td><td class="right"><strong>${rupees(totals.upi)}</strong></td><td class="right"><strong>${rupees(totals.card)}</strong></td></tr></tfoot>` : "";
  const body = `<section class="report-print wide"><header><p class="report-kicker">DIRECTQR</p><h1>Sales Summary</h1><p>${escapeHtml(restaurantName)} · ${escapeHtml(from)} to ${escapeHtml(to)}</p></header><table><thead><tr><th>Order</th><th>Table / token</th><th>Time</th><th class="right">Subtotal</th><th class="right">Discount</th><th class="right">Container</th><th class="right">GST</th><th class="right">Round off</th><th class="right">Grand total</th><th class="right">Cash</th><th class="right">UPI</th><th class="right">Card</th></tr></thead><tbody>${rows}</tbody>${footer}</table><footer>Generated by DirectQR</footer></section>`;
  writeReportPrintDocument(win, "Sales summary", body);
}

function writeReportPrintDocument(win, title, body) {
  win.onload = () => {
    win.focus();
    win.print();
  };
  win.onafterprint = () => {
    if (!win.closed) win.close();
  };
  win.document.open();
  win.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>@page{size:A4 landscape;margin:12mm}*{box-sizing:border-box}body{font-family:Arial,sans-serif;color:#111;margin:0}.report-print{width:100%;font-size:11px}.report-print header{border-bottom:2px solid #111;padding-bottom:8px;margin-bottom:12px}.report-print h1{font-size:22px;margin:2px 0}.report-print p{margin:3px 0;color:#444}.report-kicker{font-weight:800;letter-spacing:.15em;font-size:10px}.report-print table{width:100%;border-collapse:collapse}.report-print th,.report-print td{border-bottom:1px solid #d8d8d8;padding:7px 8px;text-align:left;white-space:nowrap}.report-print th{background:#f2f3f5;font-size:9px;text-transform:uppercase;letter-spacing:.06em}.report-print .right{text-align:right}.report-print tfoot td{background:#f2f3f5;border-top:2px solid #111;font-weight:700}.report-print footer{margin-top:12px;text-align:right;color:#555;font-size:9px}.empty-row{text-align:center!important;color:#555;padding:24px!important}@media print{body{margin:0}}</style></head><body>${body}</body></html>`);
  win.document.close();
}
function writePrintDocument(win, title, body) {
  win.onload = () => {
    win.focus();
    win.print();
  };
  win.onafterprint = () => {
    if (!win.closed) win.close();
  };
  win.document.open();
  win.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>@page{size:auto;margin:3mm}*{box-sizing:border-box}body{font-family:Arial,sans-serif;color:#111;margin:0}.ticket{width:72mm;margin:0 auto;padding:4px;font-size:10px;line-height:1.22}.ticket h1,.ticket h2{text-align:center;margin:2px 0}.ticket h1{font-size:14px;line-height:1.2}.ticket h2{font-size:9px;letter-spacing:.07em}.ticket p{margin:2px 0}.center{text-align:center}.meta{text-align:center;line-height:1.28;font-size:9px}.bill-meta-grid{display:grid;grid-template-columns:1fr 1fr;gap:2px 6px;font-size:8.5px;font-weight:700}.ticket table{width:100%;border-collapse:collapse}.ticket th{font-size:8px;text-transform:uppercase;text-align:left;border-bottom:1px solid #111;padding:2px 0}.ticket td{padding:3px 0;vertical-align:top;border-bottom:1px dashed #ddd;line-height:1.22}.ticket .addon-line td{padding-top:1px;color:#444}.ticket small{color:#444;font-size:8px}.right{text-align:right}.serial{width:18px;text-align:left}.bill-line{display:flex;justify-content:space-between;gap:8px;padding:2px 0}.total{font-size:12px;padding-top:5px;border-top:1px solid #111;margin-top:3px}.payment-line{text-align:center;font-weight:700;margin-top:4px;font-size:9px}.customer-line{border-bottom:1px solid #bbb;padding-bottom:2px}.notice{font-weight:700;text-align:center;border:1px dashed #111;padding:4px;font-size:9px}.notice.cancel{background:#eee}.footer{text-align:center;color:#555;margin-top:7px;font-size:8px}hr{border:0;border-top:1px solid #111;margin:4px 0}@media print{.ticket{width:auto;margin:0;padding:0}}</style></head><body>${body}</body></html>`);
  win.document.close();
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#039;", '"': "&quot;" })[character]);
}
createRoot(document.getElementById("root")).render(<App />);
