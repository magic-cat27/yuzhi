// Group by the server-owned account ID, never by a student's editable name.
export function recordIdentity(record) {
  const student=record.student;
  if(record.ownerId&&student?.id===record.ownerId) return {
    key:`account:${record.ownerId}`, kind:student.role==='teacher'?'teacher':'student',
    name:student.name, username:student.username,
  };
  return {key:`legacy:${record.studentId||record.id}`,kind:'legacy',name:'历史演示',username:record.studentId||record.id};
}
export function groupRecords(records) {
  const groups=new Map();
  for(const record of records){
    const identity=recordIdentity(record);
    if(!groups.has(identity.key))groups.set(identity.key,{...identity,records:[],projects:new Set(),edits:0,messages:0,updatedAt:''});
    const group=groups.get(identity.key);
    group.records.push(record);group.projects.add(record.projectId);
    group.edits+=record.edits||0;group.messages+=record.messages||0;
    if(record.updatedAt>group.updatedAt)group.updatedAt=record.updatedAt;
  }
  return [...groups.values()].map(group=>({...group,projectCount:group.projects.size,
    records:group.records.sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt))
  })).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));
}
