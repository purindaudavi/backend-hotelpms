const Property = require("../db_models/property.model");
const RoomType = require("../db_models/rooms.model");
const { HousekeepingAttendant, HousekeepingTask, HousekeepingActivity } = require("../db_models/housecleaning.model");
const { propertyRole } = require("./property-access.service");

function denied(message) { return Object.assign(new Error(message), { statusCode: 403 }); }

async function linkedAttendant(req, propertyId, session = null) {
  // Identity is from the verified JWT, never from user/attendant IDs in the body.
  const user = req.workspaceUser;
  if (!user?._id) throw denied("Sign in with your Housekeeping account.");
  const property = await Property.findOne({ property_id: propertyId }).session(session);
  if (propertyRole(property, user) !== "housekeeping") throw denied("Your Housekeeping access has changed. Reload the page.");
  const link = property.staff_roles.find(item => String(item.user_id) === String(user._id));
  if (!link?.attendant_id) throw denied("Ask an owner/administrator to link your login to an attendant record.");
  const attendant = await HousekeepingAttendant.findOne({ _id: link.attendant_id, property_id: propertyId, status: "active" }).session(session);
  if (!attendant) throw denied("Your linked attendant is inactive or unavailable. Contact an owner/administrator.");
  return { attendant, property };
}

async function assertOwnTask(req, propertyId, task, session) {
  if (req.propertyRole !== "housekeeping") return;
  const { attendant } = await linkedAttendant(req, propertyId, session);
  if (String(task.attendant?.attendant_id || "") !== String(attendant._id)) throw denied("You can update only tasks assigned to you.");
}

function calendarDayRange(now, timeZone) {
  let formatter;
  const options = { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" };
  try { formatter = new Intl.DateTimeFormat("en-GB", { ...options, timeZone }); }
  catch { timeZone = "Asia/Colombo"; formatter = new Intl.DateTimeFormat("en-GB", { ...options, timeZone }); }
  const parts = date => Object.fromEntries(formatter.formatToParts(date).filter(part => part.type !== "literal").map(part => [part.type, Number(part.value)]));
  const today = parts(now);
  function midnight(target) {
    let guess = target;
    for (let attempt = 0; attempt < 4; attempt++) {
      const value = parts(new Date(guess));
      const zoned = Date.UTC(value.year, value.month - 1, value.day, value.hour, value.minute, value.second);
      guess = target - (zoned - guess);
    }
    return new Date(guess);
  }
  return { start: midnight(Date.UTC(today.year, today.month - 1, today.day)), end: midnight(Date.UTC(today.year, today.month - 1, today.day + 1)),
    date: `${today.year}-${String(today.month).padStart(2, "0")}-${String(today.day).padStart(2, "0")}`, timeZone };
}

function projectTask(task, room, roomType) {
  const blocked = !room?.active || !roomType?.active || room.operational_status !== "available";
  return { id: String(task._id), room_id: String(task.physical_room_id), room_number: room?.room_number || task.room_number,
    room_type: roomType?.name || task.room_type_name, floor: room?.floor || "", status: task.status, priority: task.priority,
    notes: task.notes || "", requested_at: task.requested_at, assigned_at: task.assigned_at, started_at: task.started_at,
    blocked_reason: blocked ? "This room is not currently serviceable. Contact an owner/administrator." : "" };
}

async function myWork(req, propertyId) {
  const { attendant, property } = await linkedAttendant(req, propertyId);
  const day = calendarDayRange(new Date(), property.info?.timezone || "Asia/Colombo");
  const [requests, own, roomTypes, completedToday, recent, team] = await Promise.all([
    HousekeepingTask.find({ property_id: propertyId, status: "requested", "attendant.attendant_id": null }).sort({ requested_at: 1 }).lean(),
    HousekeepingTask.find({ property_id: propertyId, "attendant.attendant_id": attendant._id, status: { $in: ["assigned", "in_progress"] } }).sort({ assigned_at: 1 }).lean(),
    RoomType.find({ property_id: propertyId }).select("name active physical_rooms").lean(),
    HousekeepingActivity.find({ property_id: propertyId, "attendant.attendant_id": attendant._id, action: "cleaning_completed", created_at: { $gte: day.start, $lt: day.end } }).sort({ created_at: -1 }).lean(),
    HousekeepingActivity.find({ property_id: propertyId, "attendant.attendant_id": attendant._id, action: "cleaning_completed" }).sort({ created_at: -1 }).limit(100).lean(),
    // Shared awareness only: no other employee's notes, contacts or task controls.
    HousekeepingTask.find({ property_id: propertyId, "attendant.attendant_id": { $ne: attendant._id }, status: { $in: ["assigned", "in_progress"] } })
      .select("physical_room_id room_number room_type_name status attendant.name attendant.attendant_id assigned_at started_at")
      .sort({ assigned_at: -1 }).limit(100).lean()
  ]);
  const rooms = new Map(roomTypes.flatMap(type => type.physical_rooms.map(room => [String(room._id), { room, type }])));
  const project = task => { const found = rooms.get(String(task.physical_room_id)); return projectTask(task, found?.room, found?.type); };
  const completed = activity => ({ id: String(activity._id), room_number: activity.room_number, room_type: activity.room_type_name,
    completed_at: activity.created_at, notes: activity.notes || "" });
  return { attendant: { id: String(attendant._id), name: attendant.name, employee_number: attendant.employee_number }, date: day.date, timezone: day.timeZone,
    requests: requests.map(project).filter(task => !task.blocked_reason),
    assigned: own.filter(task => task.status === "assigned").map(project), in_progress: own.filter(task => task.status === "in_progress").map(project),
    completed_today: completedToday.map(completed), recent_completed: recent.map(completed),
    team_assignments: team.filter(task => task.attendant?.attendant_id).map(task => {
      const found = rooms.get(String(task.physical_room_id));
      return { id: String(task._id), room_number: found?.room.room_number || task.room_number,
        room_type: found?.type.name || task.room_type_name, status: task.status,
        attendant_name: task.attendant.name || "Assigned attendant", assigned_at: task.assigned_at, started_at: task.started_at };
    }) };
}

module.exports = { linkedAttendant, assertOwnTask, myWork, projectTask, calendarDayRange };
