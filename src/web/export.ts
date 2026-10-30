// Spreadsheet export: jobs, steps and rework, one sheet each. Anyone signed in can download it.
import ExcelJS from 'exceljs';
import { pool } from '../db/pool.js';
import { KINDS, StepKind } from '../domain/steps.js';

const DATE_FMT = 'dd mmm yyyy';
const asDate = (d: string | null) => (d ? new Date(`${d}T00:00:00Z`) : null);

export async function exportWorkbook(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Aalbor Hub';

  const jobs = (await pool.query('select * from jobs order by site_start nulls last, client_name')).rows;
  const js = wb.addWorksheet('Jobs');
  js.columns = [
    { header: 'Job number', key: 'job_number', width: 12 }, { header: 'Brand', key: 'brand', width: 9 },
    { header: 'Client', key: 'client_name', width: 28 }, { header: 'Suburb', key: 'suburb', width: 18 },
    { header: 'Status', key: 'status', width: 10 }, { header: 'At risk', key: 'at_risk', width: 8 },
    { header: 'Door finish', key: 'door_finish', width: 13 }, { header: 'Painting', key: 'has_painting', width: 9 }, { header: 'Stone', key: 'has_stone', width: 7 },
    { header: 'Site start', key: 'site_start', width: 13, style: { numFmt: DATE_FMT } },
    { header: 'Factory days', key: 'factory_days', width: 12 }, { header: 'Install days', key: 'install_days', width: 12 },
    { header: 'Scope', key: 'scope', width: 50 }, { header: 'Notes', key: 'notes', width: 50 },
  ];
  for (const j of jobs) js.addRow({ ...j, site_start: asDate(j.site_start), at_risk: j.at_risk ? 'Yes' : '', has_painting: j.has_painting ? 'Yes' : 'No', has_stone: j.has_stone ? 'Yes' : 'No' });

  const steps = (await pool.query(
    `select s.*, j.job_number, j.client_name, p.name as done_by_name from steps s join jobs j on j.id = s.job_id
     left join people p on p.id = s.done_by order by j.client_name, s.sort, s.id`)).rows;
  const ss = wb.addWorksheet('Steps');
  ss.columns = [
    { header: 'Job number', key: 'job_number', width: 12 }, { header: 'Client', key: 'client_name', width: 28 },
    { header: 'Step', key: 'step', width: 28 }, { header: 'Owner', key: 'owner', width: 12 },
    { header: 'From', key: 'start_date', width: 13, style: { numFmt: DATE_FMT } }, { header: 'To', key: 'end_date', width: 13, style: { numFmt: DATE_FMT } },
    { header: 'Confirmed', key: 'confirmed', width: 10 }, { header: 'Done', key: 'done', width: 13, style: { numFmt: DATE_FMT } },
    { header: 'Done by', key: 'done_by_name', width: 14 }, { header: 'Note', key: 'note', width: 40 },
  ];
  for (const s of steps) {
    ss.addRow({
      ...s, step: s.label || KINDS[s.kind as StepKind].label, start_date: asDate(s.start_date), end_date: asDate(s.end_date),
      confirmed: s.confirmed ? 'Yes' : 'Provisional', done: s.done_at ? new Date(s.done_at) : null,
    });
  }

  const rw = (await pool.query(
    `select r.*, j.job_number, j.client_name, p.name as raised_by_name from rework r join jobs j on j.id = r.job_id
     left join people p on p.id = r.raised_by order by r.raised_at`)).rows;
  const rs = wb.addWorksheet('Rework');
  rs.columns = [
    { header: 'Job number', key: 'job_number', width: 12 }, { header: 'Client', key: 'client_name', width: 28 },
    { header: 'Cause', key: 'cause', width: 14 }, { header: 'What happened', key: 'note', width: 50 },
    { header: 'Raised by', key: 'raised_by_name', width: 14 }, { header: 'Raised', key: 'raised', width: 13, style: { numFmt: DATE_FMT } },
    { header: 'Closed', key: 'closed', width: 13, style: { numFmt: DATE_FMT } },
    { header: 'Extra hours', key: 'extra_hours', width: 12 }, { header: 'Extra material $', key: 'extra_material_cost', width: 16 },
  ];
  for (const r of rw) rs.addRow({ ...r, raised: new Date(r.raised_at), closed: asDate(r.closed_on) });

  for (const sheet of [js, ss, rs]) {
    sheet.getRow(1).font = { bold: true };
    sheet.views = [{ state: 'frozen', ySplit: 1 }];
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}
