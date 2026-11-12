// Property roles are independent of global account/reviewer roles. General
// members keep their existing operational access until department roles ship.
const OPERATIONAL_PERMISSIONS = ["operations.manage", "settings.manage"];
const ADMIN_PERMISSIONS = [...OPERATIONAL_PERMISSIONS, "channels.manage", "staff.manage", "housekeeping.staff.manage", "housekeeping.assign", "housekeeping.request"];
const FRONT_DESK_PERMISSIONS = ["dashboard.operations.read", "reservations.manage", "guests.manage", "rooms.read", "rates.read", "housekeeping.read", "housekeeping.assign", "housekeeping.request", "agents.read", "invoices.read", "payments.record", "notifications.operations.read"];
const FINANCE_REPORT_TYPES = Object.freeze(["collection-report", "deposit-ledger", "revenue-report", "revenue-forecast", "customer-balance-summary", "ar-aging-summary", "in-house-guest-ledger", "travel-agent-performance"]);
const FINANCE_PERMISSIONS = ["dashboard.finance.read", "financials.manage", "reservations.billing.read", "reports.finance.read", "night-audit.read", "notifications.finance.read"];
const ROLE_PERMISSIONS = Object.freeze({
  owner: Object.freeze([...ADMIN_PERMISSIONS, "administrators.manage", "subscription.manage"]),
  administrator: Object.freeze(ADMIN_PERMISSIONS),
  member: Object.freeze(OPERATIONAL_PERMISSIONS),
  front_desk: Object.freeze(FRONT_DESK_PERMISSIONS),
  housekeeping: Object.freeze(["housekeeping.self.read", "housekeeping.self.manage"]),
  finance: Object.freeze(FINANCE_PERMISSIONS),
  demo: Object.freeze([])
});

function permissionsForRole(role) {
  return Object.hasOwn(ROLE_PERMISSIONS, role) ? [...ROLE_PERMISSIONS[role]] : [];
}

function permissionsForProperty(role, property, userId) {
  const permissions = permissionsForRole(role);
  const assignment = property?.staff_roles?.find(item => String(item.user_id) === String(userId));
  if (role === "front_desk" && assignment?.run_night_audit === true) permissions.push("night-audit.run");
  return permissions;
}

function canRunNightAudit(role, permissions = []) {
  return ["owner", "administrator"].includes(role) || (role === "front_desk" && permissions.includes("night-audit.run"));
}

function hasPropertyPermission(role, permission) {
  return permissionsForRole(role).includes(permission);
}

function requirePropertyPermission(permission) {
  return (req, res, next) => {
    if (!hasPropertyPermission(req.propertyRole, permission)) {
      return res.status(403).json({ message: "Your property role does not allow this action.", code: "PROPERTY_PERMISSION_DENIED" });
    }
    next();
  };
}

// Only explicitly listed API operations are available to restricted staff.
// Existing owner/admin/general-member workflows keep their operational access.
function authorizePropertyRequest(req, res, next) {
  if (req.path === "/activity-logs" || req.path.startsWith("/activity-logs/")) {
    if (req.method === "GET" && ["owner", "administrator"].includes(req.propertyRole)) return next();
    return res.status(403).json({ message: "Only the property Owner or Administrator can view activity logs.", code: "PROPERTY_PERMISSION_DENIED" });
  }
  if (req.path === "/money-requests" || req.path.startsWith("/money-requests/")) {
    // Route handlers recheck the current property and owner/requester scope.
    if (["owner", "administrator", "finance", "front_desk", "housekeeping"].includes(req.propertyRole)) return next();
    return res.status(403).json({ message: "Your role cannot use money requests.", code: "PROPERTY_PERMISSION_DENIED" });
  }
  if (req.path.startsWith("/night-audit/")) {
    const path = req.path.replace(/\/+$/, "");
    const runner = canRunNightAudit(req.propertyRole, req.propertyPermissions);
    const read = req.method === "GET" && /^\/night-audit\/(?:current|history|[a-f\d]{24}(?:\/reports\/[a-f\d]{24})?)$/i.test(path);
    const review = req.method === "POST" && /^\/night-audit\/[a-f\d]{24}\/finance-review$/i.test(path);
    if ((read && (runner || req.propertyRole === "finance")) || (review && ["owner", "administrator", "finance"].includes(req.propertyRole))) return next();
    if (runner && req.method === "POST" && /^\/night-audit\/current\/(?:override|reconciliation|run)$/.test(path) &&
        (!path.endsWith("/override") || ["owner", "administrator"].includes(req.propertyRole))) return next();
    return deny();
  }
  if (hasPropertyPermission(req.propertyRole, "operations.manage")) return next();
  if (req.propertyRole === "finance") {
    const path = req.path.replace(/\/+$/, ""), method = req.method;
    const rules = [
      ["GET", /^\/properties\/[^/]+(?:\/(?:my-access|theme|images))?$/],
      ["GET", /^\/finance\/overview$/],
      ["GET", /^\/bookings\/reservations(?:\/[^/]+)?$/],
      ["GET", /^\/(?:transactions|invoices|credits|refunds|withdrawals)(?:\/[^/]+)?$/],
      ["GET", /^\/invoices\/[^/]+\/payments$/],
      ["POST", /^\/invoices(?:\/[^/]+\/issue|\/[^/]+\/payments)?$/],
      ["PATCH", /^\/invoices\/[^/]+$/],
      ["POST", /^\/(?:credits|refunds|withdrawals)$/],
      ["PATCH", /^\/(?:credits|refunds)\/[^/]+$/],
      ["GET", /^\/(?:purchases|expenses|receivables|financial-targets)$/],
      ["POST", /^\/(?:purchases|expenses)$/],
      ["POST", /^\/purchases\/[^/]+\/pay$/],
      ["GET", /^\/reports\/(?:catalog|history)(?:\/[^/]+)?$/],
      ["POST", /^\/reports\/generate$/],
      ["GET", /^\/night-audit\/(?:current|history|[a-f\d]{24})$/i],
      ["GET", /^\/notifications$/],
      ["PATCH", /^\/notifications\/[^/]+\/read$/],
      ["POST", /^\/notifications\/read-all$/]
    ];
    if (!rules.some(([verb, pattern]) => verb === method && pattern.test(path))) return deny();
    if (path === "/reports/generate" && !FINANCE_REPORT_TYPES.includes(req.body?.report_type)) return deny();
    if (method === "POST" && /\/payments$/.test(path) && req.body?.status !== undefined && req.body.status !== "posted") return deny();
    return next();
  }
  if (req.propertyRole === "housekeeping") {
    const path = req.path.replace(/\/+$/, "");
    if (req.method === "GET" && (/^\/properties\/[^/]+(?:\/(?:my-access|theme|images))?$/.test(path) || path === "/housekeeping/my-work")) return next();
    if (req.method === "POST" && /^\/housekeeping\/rooms\/[^/]+\/(?:claim|start|complete)$/.test(path)) return next();
    if ((req.method === "GET" && path === "/notifications") ||
        (req.method === "PATCH" && /^\/notifications\/[^/]+\/read$/.test(path)) ||
        (req.method === "POST" && path === "/notifications/read-all")) return next();
    return deny();
  }
  if (req.propertyRole !== "front_desk") return deny();
  const path = req.path.replace(/\/+$/, "");
  const method = req.method;
  const rules = [
    ["GET", /^\/properties\/[^/]+(?:\/(?:my-access|theme|images|meal-allocations))?$/],
    ["GET", /^\/rooms(?:\/physical-rooms|\/[^/]+)?$/],
    ["GET", /^\/rates(?:\/default-suggestions|\/[^/]+(?:\/daily-rates)?)?$/],
    ["POST", /^\/rates\/quote$/],
    ["GET", /^\/housekeeping(?:\/activities)?$/],
    ["POST", /^\/housekeeping\/rooms\/[^/]+\/(?:assign|request)$/],
    ["GET", /^\/travel-agents(?:\/[^/]+)?$/],
    ["GET", /^\/cross-bookings$/],
    ["GET", /^\/guests(?:\/[^/]+|\/findbymail\/[^/]+)?$/],
    ["POST", /^\/guests$/],
    ["PATCH", /^\/guests\/[^/]+$/],
    ["GET", /^\/bookings\/reservations(?:\/[^/]+(?:\/(?:payments|logs|checkout-review|attachments)(?:\/[^/]+\/file)?)?)?$/],
    ["GET", /^\/bookings\/business-blocks(?:\/[^/]+)?$/],
    ["POST", /^\/bookings\/reservations$/],
    ["PATCH", /^\/bookings\/reservations\/[^/]+(?:\/email-delivery|\/occupants\/[^/]+)?$/],
    ["POST", /^\/bookings\/reservations\/[^/]+\/(?:confirm|check-in|check-out|cancel|no-show|room-moves|occupants|attachments|payments)$/],
    ["DELETE", /^\/bookings\/reservations\/[^/]+\/(?:occupants|attachments)\/[^/]+$/],
    ["GET", /^\/invoices(?:\/[^/]+(?:\/payments)?)?$/],
    ["POST", /^\/invoices\/[^/]+\/payments$/],
    ["GET", /^\/notifications$/],
    ["PATCH", /^\/notifications\/[^/]+\/read$/],
    ["POST", /^\/notifications\/read-all$/],
    ["POST", /^\/mail\/(?:confirmation|check-in|check-out|cancellation|remind|no-show)$/]
  ];
  if (!rules.some(([verb, pattern]) => verb === method && pattern.test(path))) return deny();
  if (method === "POST" && /\/payments$/.test(path) &&
      req.body?.status !== undefined && req.body.status !== "posted") {
    return res.status(403).json({ message: "Front Desk can record payments. Refunds and payment voids require an owner or administrator.", code: "PROPERTY_PERMISSION_DENIED" });
  }
  next();
  function deny() {
    return res.status(403).json({ message: "Your property role does not allow this action.", code: "PROPERTY_PERMISSION_DENIED" });
  }
}

module.exports = { permissionsForRole, permissionsForProperty, canRunNightAudit, hasPropertyPermission, requirePropertyPermission, authorizePropertyRequest, FINANCE_REPORT_TYPES };
