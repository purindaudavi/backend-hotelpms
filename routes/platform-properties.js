const express = require("express");
const mongoose = require("mongoose");
const Property = require("../db_models/property.model");
const User = require("../db_models/user.model");
const { setPropertyArchived } = require("../services/property-archive.service");
const { withInventoryTransaction } = require("../services/inventory-transaction.service");
const { actorFromRequest, writeAuditLog } = require("../services/booking-audit.service");
const { requirePlatformOwner, error } = require("../services/property-creation.service");
const router = express.Router();
router.use(requirePlatformOwner);
const run = handler => (req, res, next) => Promise.resolve(handler(req,res)).catch(next);
function integer(value, fallback, max) { const parsed = value === undefined ? fallback : Number(value); if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) throw error(400,"Invalid pagination.");return parsed; }
function propertyId(value) { if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{1,99}$/.test(value)) throw error(400,"Invalid property ID.");return value; }
function text(value,min,max,label) { if (typeof value !== "string" || value.trim().length < min || value.trim().length > max) throw error(400,`Check ${label} (${min}–${max} characters).`);return value.trim(); }
function summary(record,owner=null) { return {property_id:record.property_id,hotel_name:record.info.hotel_name,city:record.info.city||"",country_code:record.info.country_code||"",status:record.status,
  version:record.version??0,created_at:record.created_at,archived_at:record.platform_archived_at||null,archive_reason:record.platform_archive_reason||"",member_count:record.member_ids?.length||0,
  owner:owner?{id:String(owner._id),name:owner.name,email:owner.email,approved_limit:owner.property_creation_limit||0}:null}; }
router.get("/",run(async(req,res)=>{
  const status=req.query.status||"active";
  if(!["active","inactive","all"].includes(status))throw error(400,"Choose Active, Archived or All properties.");
  const page=integer(req.query.page,1,100000),limit=integer(req.query.limit,25,100);
  const filter=status==="all"?{}:{status};
  if(req.query.search!==undefined){const search=text(req.query.search,0,100,"search");if(search){const regex=new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g,"\\$&"),"i");filter.$or=[{property_id:regex},{"info.hotel_name":regex}];}}
  const [records,total]=await Promise.all([Property.find(filter).select("property_id info.hotel_name info.city info.country_code owner_id member_ids status version created_at platform_archived_at platform_archive_reason").sort({created_at:-1,_id:-1}).skip((page-1)*limit).limit(limit).lean(),Property.countDocuments(filter)]);
  const owners=await User.find({_id:{$in:records.map(record=>record.owner_id).filter(Boolean)}}).select("name email property_creation_limit").lean();
  const byId=new Map(owners.map(owner=>[String(owner._id),owner]));
  res.json({properties:records.map(record=>summary(record,byId.get(String(record.owner_id)))),total,page,limit,has_more:page*limit<total});
}));
async function mutate(req,action){
  const id=propertyId(req.params.propertyId);
  const version=req.body?.version;
  if(!Number.isInteger(version)||version<0)throw error(400,"Refresh the property before making this change.");
  const reason=text(req.body?.reason,5,1000,"reason");
  const newName=action==="rename"?text(req.body?.hotel_name,2,180,"property name"):null;
  return withInventoryTransaction(id,async session=>{
    const record=await Property.findOne({property_id:id}).session(session);
    if(!record)throw error(404,"Property not found.");
    if((record.version??0)!==version)throw error(409,"This property changed. Refresh the list before trying again.","PROPERTY_VERSION_CONFLICT");
    const actor=actorFromRequest(req),changes=[];
    if(action==="rename"){
      if(record.info.hotel_name===newName)throw error(409,"Choose a different property name.");
      changes.push({field:"info.hotel_name",from:record.info.hotel_name,to:newName});record.info.hotel_name=newName;
    }else{
      if(req.body?.confirm_name!==record.info.hotel_name)throw error(400,"Type the current property name exactly to confirm.");
      if(action==="archive"&&record.status!=="active")throw error(409,"This property is already archived.");
      if(action==="restore"&&record.status!=="inactive")throw error(409,"This property is already active.");
      const archived=action==="archive";
      changes.push({field:"status",from:record.status,to:archived?"inactive":"active"});
      await setPropertyArchived(record,archived,actor,reason,session);
    }
    record.updated_by=actor;await record.save({session});
    await writeAuditLog({propertyId:id,entityType:"property",entityId:record._id,action:`property_platform_${action==="rename"?"renamed":action==="archive"?"archived":"restored"}`,
      description:`Platform ${action}: ${record.info.hotel_name}. Reason: ${reason}`,actor,changes,requestId:req.get("x-request-id")||"",session});
    const owner=record.owner_id?await User.findById(record.owner_id).select("name email property_creation_limit").session(session):null;
    return summary(record,owner);
  },{allowArchivedProperty:true});
}
router.post("/:propertyId/rename",run(async(req,res)=>res.json({message:"Property name updated. Its permanent ID and linked records are preserved.",property:await mutate(req,"rename")})));
router.post("/:propertyId/archive",run(async(req,res)=>res.json({message:"Property archived. Access is blocked and records are preserved for restoration.",property:await mutate(req,"archive")})));
router.post("/:propertyId/restore",run(async(req,res)=>res.json({message:"Property restored with its existing ID, records and staff access.",property:await mutate(req,"restore")})));
router.use((failure,_req,res,next)=>{if(failure instanceof mongoose.Error.VersionError)return res.status(409).json({message:"This property changed. Refresh before trying again.",code:"PROPERTY_VERSION_CONFLICT"});if(failure instanceof mongoose.Error.ValidationError)return res.status(400).json({message:"Check the property name and reason."});next(failure);});
module.exports=router;
