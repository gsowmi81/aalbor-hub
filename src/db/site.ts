// The site link and the site log (George, 7 Nov 2026): reads.
import { pool } from './pool.js';

export interface SiteLink {
  id: number;
  job_id: number;
  person_id: number;
  person_name: string;
  token: string;
  created_at: string;
  created_by_name: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
}

export interface SiteLog {
  id: number;
  job_id: number;
  step_id: number | null;
  person_id: number;
  person_name: string;
  kind: 'log' | 'missing' | 'finished';
  note: string;
  issue_id: number | null;
  issue_status: 'open' | 'looking' | 'fixed' | null;
  at: string;
  photo_ids: number[];
}

export async function loadSiteLinks(jobId: number): Promise<SiteLink[]> {
  return (await pool.query(`select l.id, l.job_id, l.person_id, p.name as person_name, l.token, l.created_at, c.name as created_by_name, l.last_used_at, l.revoked_at
    from site_links l join people p on p.id = l.person_id left join people c on c.id = l.created_by where l.job_id = $1 order by l.revoked_at nulls first, l.id desc`, [jobId])).rows;
}

export async function loadSiteLogs(jobId: number): Promise<SiteLog[]> {
  return (await pool.query(`select l.id, l.job_id, l.step_id, l.person_id, p.name as person_name, l.kind, l.note, l.issue_id, i.status as issue_status, l.at,
      coalesce((select array_agg(ph.id order by ph.id) from site_log_photos ph where ph.log_id = l.id), '{}') as photo_ids
    from site_logs l join people p on p.id = l.person_id left join issues i on i.id = l.issue_id where l.job_id = $1 order by l.at desc, l.id desc`, [jobId])).rows;
}

/** Installers who sign in only by a job link, with the jobs their links are on (Settings → People). */
export async function loadInstallers(): Promise<{ id: number; name: string; active: boolean; jobs: string[] }[]> {
  return (await pool.query(`select p.id, p.name, p.active,
      coalesce((select array_agg(distinct j.client_name order by j.client_name) from site_links l join jobs j on j.id = l.job_id where l.person_id = p.id and l.revoked_at is null), '{}') as jobs
    from people p where p.link_only order by p.active desc, p.name`)).rows;
}
