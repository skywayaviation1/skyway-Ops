import {
  authorizeAppUser,
  authorizeJake,
  authorizeSuperAdmin,
  getDb,
  isJakeOwner,
  writeAudit,
} from './_super-admin.js';

export const config = { runtime: 'nodejs' };

function bodyOf(req) {
  return typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
}

function cleanNavigation(value) {
  const sections = {};
  for (const [id, section] of Object.entries(value?.sections || {})) {
    const safeId = String(id).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80);
    if (!safeId) continue;
    sections[safeId] = {
      label: String(section?.label || safeId).trim().slice(0, 80),
      roles: [...new Set((Array.isArray(section?.roles) ? section.roles : [])
        .map((role) => String(role).toLowerCase())
        .filter((role) => ['crew', 'sales', 'ops', 'maint', 'accounting', 'admin'].includes(role)))],
    };
  }
  const groups = (Array.isArray(value?.groups) ? value.groups : []).map((group) => ({
    id: String(group?.id || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80),
    label: String(group?.label || '').trim().slice(0, 80),
    children: (Array.isArray(group?.children) ? group.children : [])
      .map((id) => String(id).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80))
      .filter((id) => sections[id]),
  })).filter((group) => group.id && group.children.length);
  return { version: 1, sections, groups };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  try {
    const body = bodyOf(req);
    if (body.action === 'get') {
      const actor = await authorizeAppUser(body.idToken);
      const snap = await getDb().doc('app-config/navigation').get();
      return res.status(200).json({
        ok: true,
        navigation: snap.exists ? snap.data() : null,
        superAdmin: actor.superAdmin,
        owner: isJakeOwner(actor),
      });
    }
    if (body.action === 'saveNavigation') {
      const actor = await authorizeSuperAdmin(body.idToken);
      const navigation = {
        ...cleanNavigation(body.navigation),
        updatedAt: Date.now(),
        updatedByUid: actor.uid,
        updatedByEmail: actor.email,
      };
      await getDb().doc('app-config/navigation').set(navigation);
      await writeAudit(actor, {
        action: 'navigation.publish',
        summary: 'Published navigation grouping and role access policy',
        targetType: 'app-config',
        targetId: 'navigation',
      }, 'api');
      return res.status(200).json({ ok: true, navigation });
    }
    if (body.action === 'grantSuperAdmin') {
      const actor = await authorizeJake(body.idToken);
      const uid = String(body.uid || '').trim();
      if (!uid) return res.status(400).json({ error: 'uid required' });
      const targetRef = getDb().collection('users').doc(uid);
      const target = await targetRef.get();
      if (!target.exists) return res.status(404).json({ error: 'User not found' });
      const enabled = body.enabled === true;
      await targetRef.set({
        superAdmin: enabled,
        superAdminUpdatedAt: Date.now(),
        superAdminUpdatedByUid: actor.uid,
      }, { merge: true });
      await writeAudit(actor, {
        action: enabled ? 'super-admin.grant' : 'super-admin.revoke',
        summary: `${enabled ? 'Granted' : 'Revoked'} super admin for ${target.data()?.email || uid}`,
        targetType: 'user',
        targetId: uid,
      }, 'api');
      return res.status(200).json({ ok: true, uid, superAdmin: enabled });
    }
    return res.status(400).json({ error: 'Unknown super admin action' });
  } catch (error) {
    return res.status(error.status || 500).json({ error: error.message || 'Super admin request failed' });
  }
}

