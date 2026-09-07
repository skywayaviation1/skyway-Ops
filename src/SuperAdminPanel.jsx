import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, RefreshCw, Save, Shield } from 'lucide-react';
import { Button, Card, PageHeader, StatusChip } from './ui.jsx';
import { postJson } from './api-json.js';

const ROLES = ['crew', 'sales', 'ops', 'maint', 'accounting', 'admin'];

async function token() {
  const { auth } = await import('./firebase.js');
  return auth.currentUser?.getIdToken();
}

export default function SuperAdminPanel({ currentUser, users = [], defaults }) {
  const [tab, setTab] = useState('navigation');
  const [navigation, setNavigation] = useState(defaults);
  const [events, setEvents] = useState([]);
  const [owner, setOwner] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  async function request(action, extra = {}) {
    return postJson('/api/super-admin', {
      idToken: await token(),
      action,
      ...extra,
    });
  }

  async function load() {
    setBusy('load');
    setError('');
    try {
      const data = await request('get');
      setOwner(data.owner === true);
      if (data.navigation?.sections && data.navigation?.groups) {
        setNavigation(data.navigation);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  }

  async function loadAudit() {
    if (!owner) return;
    setBusy('audit');
    setError('');
    try {
      const data = await postJson('/api/audit-events', {
        idToken: await token(),
        action: 'query',
        limit: 300,
      });
      setEvents(data.events || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  }

  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (tab === 'audit' && owner) loadAudit(); }, [tab, owner]); // eslint-disable-line react-hooks/exhaustive-deps

  function moveSection(sectionId, groupId) {
    setNavigation((current) => ({
      ...current,
      groups: current.groups.map((group) => ({
        ...group,
        children: group.id === groupId
          ? [...group.children.filter((id) => id !== sectionId), sectionId]
          : group.children.filter((id) => id !== sectionId),
      })),
    }));
  }

  function toggleRole(sectionId, role) {
    setNavigation((current) => {
      const existing = current.sections[sectionId]?.roles || [];
      const roles = existing.includes(role)
        ? existing.filter((item) => item !== role)
        : [...existing, role];
      return {
        ...current,
        sections: {
          ...current.sections,
          [sectionId]: { ...current.sections[sectionId], roles },
        },
      };
    });
  }

  async function saveNavigation() {
    setBusy('save');
    setError('');
    setMessage('');
    try {
      const data = await request('saveNavigation', { navigation });
      setNavigation(data.navigation);
      setMessage('Navigation grouping and role visibility published.');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  }

  async function setSuperAdmin(user, enabled) {
    setBusy(`user-${user.uid}`);
    setError('');
    try {
      await request('grantSuperAdmin', { uid: user.uid, enabled });
      setMessage(`${enabled ? 'Granted' : 'Revoked'} super admin for ${user.name || user.email}.`);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  }

  const sectionRows = useMemo(() => Object.entries(navigation?.sections || {}), [navigation]);
  const groupFor = (sectionId) => navigation.groups.find((group) => group.children.includes(sectionId))?.id || '';

  return (
    <div className="flex-1 overflow-y-auto scroll-area bg-surface-sunken p-4 md:p-6">
      <div className="mx-auto max-w-6xl">
        <PageHeader
          title="Super admin"
          subtitle="Navigation access, super administrators, and Jake-only activity audit"
          actions={<Button variant="secondary" icon={RefreshCw} loading={busy === 'load'} onClick={load}>Refresh</Button>}
        />
        <div className="mb-4 flex flex-wrap gap-2">
          {[
            ['navigation', 'Navigation & access'],
            ['admins', 'Super admins'],
            ...(owner ? [['audit', 'Audit trail']] : []),
          ].map(([id, label]) => (
            <Button key={id} variant={tab === id ? 'primary' : 'secondary'} onClick={() => setTab(id)}>
              {label}
            </Button>
          ))}
        </div>
        {error && <p className="mb-3 flex gap-2 text-sm text-danger"><AlertTriangle className="h-4 w-4" />{error}</p>}
        {message && <p className="mb-3 flex gap-2 text-sm text-success"><CheckCircle2 className="h-4 w-4" />{message}</p>}

        {tab === 'navigation' && (
          <Card padded>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="font-semibold text-content">Tab grouping and role visibility</p>
                <p className="mt-1 text-sm text-content-muted">
                  Defaults match current access. Move each item to a group and turn roles off when ready.
                </p>
              </div>
              <Button variant="primary" icon={Save} loading={busy === 'save'} onClick={saveNavigation}>Publish access</Button>
            </div>
            <div className="mt-4 space-y-3">
              {sectionRows.map(([id, section]) => (
                <div key={id} className="rounded-xl border border-edge p-3">
                  <div className="flex flex-wrap items-center gap-3">
                    <span className="min-w-36 font-semibold text-content">{section.label}</span>
                    <select
                      value={groupFor(id)}
                      onChange={(event) => moveSection(id, event.target.value)}
                      className="rounded-lg border border-edge bg-surface px-3 py-2 text-sm text-content"
                    >
                      {navigation.groups.map((group) => <option key={group.id} value={group.id}>{group.label}</option>)}
                    </select>
                    <div className="flex flex-wrap gap-2">
                      {ROLES.map((role) => (
                        <label key={role} className="flex items-center gap-1 text-xs text-content-muted">
                          <input
                            type="checkbox"
                            checked={(section.roles || []).includes(role)}
                            onChange={() => toggleRole(id, role)}
                          />
                          {role}
                        </label>
                      ))}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </Card>
        )}

        {tab === 'admins' && (
          <Card padded>
            <p className="font-semibold text-content">Super administrators</p>
            <p className="mt-1 text-sm text-content-muted">
              Jake Cambria is the permanent owner. Only Jake can grant or revoke super admin.
            </p>
            <div className="mt-4 divide-y divide-edge">
              {users.map((user) => (
                <div key={user.uid} className="flex flex-wrap items-center justify-between gap-3 py-3">
                  <div>
                    <p className="text-sm font-semibold text-content">{user.name || user.email}</p>
                    <p className="text-xs text-content-subtle">{user.email} · {user.role}</p>
                  </div>
                  <Button
                    size="sm"
                    variant={user.superAdmin ? 'danger' : 'secondary'}
                    icon={Shield}
                    disabled={!owner}
                    loading={busy === `user-${user.uid}`}
                    onClick={() => setSuperAdmin(user, !user.superAdmin)}
                  >
                    {user.superAdmin ? 'Revoke super admin' : 'Grant super admin'}
                  </Button>
                </div>
              ))}
            </div>
          </Card>
        )}

        {tab === 'audit' && owner && (
          <Card padded>
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="font-semibold text-content">All-user activity audit</p>
                <p className="text-sm text-content-muted">Visible only to Jake Cambria.</p>
              </div>
              <StatusChip tone="info" size="sm">{events.length} recent actions</StatusChip>
            </div>
            <div className="mt-4 divide-y divide-edge">
              {events.map((event) => (
                <div key={event.id} className="grid gap-1 py-3 text-sm md:grid-cols-[11rem_12rem_1fr]">
                  <span className="font-mono text-xs text-content-subtle">{new Date(event.timestamp).toLocaleString()}</span>
                  <span className="text-content-muted">{event.actorName || event.actorEmail}</span>
                  <span className="text-content"><strong>{event.section || 'app'}</strong> · {event.summary}</span>
                </div>
              ))}
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}

