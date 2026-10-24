import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { DB } from '@/db';
import * as schema from '@/db/schema';
import { jobRuns, designs } from '@/db/schema';
import { reserveImage, quotaUsed } from '@/lib/image-quota';
import { bindUploadKey, consumeUploadKey, recordUpscaleFailure } from '@/lib/upscale-failures';
import { formatMaintenanceSummary } from '@/lib/maintenance-summary';
import { getSetting, setSetting } from '@/lib/settings';
import { liveWritesEnabled } from '@/lib/read-publish-mode';

const fns = vi.hoisted(() => ({ research: vi.fn().mockResolvedValue('done') }));
vi.mock('@/pipeline/research', () => ({runResearch: fns.research}));
vi.mock('@/pipeline/design', () => ({runDesign: vi.fn().mockResolvedValue('done')}));
vi.mock('@/pipeline/listing', () => ({runListing: vi.fn().mockResolvedValue('done')}));
vi.mock('@/pipeline/orders', () => ({runOrders: vi.fn().mockResolvedValue('done')}));
vi.mock('@/pipeline/publish', () => ({runPublish: vi.fn().mockResolvedValue('done')}));
vi.mock('@/pipeline/analytics', () => ({runAnalytics: vi.fn().mockResolvedValue('done')}));
vi.mock('@/pipeline/maintenance', () => ({runMaintenance: vi.fn().mockResolvedValue('done')}));
vi.mock('@/pipeline/hot-signals', () => ({runHot: vi.fn().mockResolvedValue('done')}));
vi.mock('@/pipeline/health-report', () => ({publishHealthReport: vi.fn()}));
vi.mock('@/lib/events', () => ({emit: vi.fn().mockResolvedValue(undefined)}));
import { runStage } from '@/pipeline/runner';

describe('isolated audit stress reproductions', () => {
  const evidence: Record<string, unknown> = {};
  const client = new PGlite('memory://');
  const db = drizzle(client, {schema}) as unknown as DB;
  beforeAll(async () => { await migrate(db, {migrationsFolder:path.join(process.cwd(),'drizzle')}); });
  afterAll(async () => { await client.close(); });

  it('prevents duplicate research execution under 25 simultaneous triggers', async () => {
    await db.delete(jobRuns);
    fns.research.mockClear();
    const runs = await Promise.all(Array.from({length:25}, () => runStage('research','manual',{db})));
    const executions = fns.research.mock.calls.length;
    evidence.parallelResearch = {requests:25, executions, success:runs.filter(r=>r.status==='success').length};
    console.log('AUDIT parallel research', JSON.stringify({requests:25,executions,success:runs.filter(r=>r.status==='success').length}));
    expect(executions).toBe(1);
  });

  it('recovers a stale running row when no lease remains', async () => {
    await db.delete(jobRuns);
    await db.insert(jobRuns).values({stage:'research',status:'running',trigger:'cron',isDemo:true,startedAt:new Date(Date.now()-360000)});
    fns.research.mockClear();
    const second = await runStage('research','cron',{db});
    expect(second.status).toBe('success');
    expect(fns.research).toHaveBeenCalledOnce();
  });

  it('holds the Cloudflare cap under 1000 concurrent reservations', async () => {
    const now = new Date('2026-10-24T00:00:00Z');
    const reservations = await Promise.all(Array.from({length:1000},()=>reserveImage(db,{provider:'cloudflare',now})));
    const accepted = reservations.filter(r=>r.ok).length;
    evidence.quota = {requests:1000,accepted,stored:await quotaUsed(db,'cloudflare:2026-10-24')};
    console.log('AUDIT quota',JSON.stringify({requests:1000,accepted,stored:await quotaUsed(db,'cloudflare:2026-10-24')}));
    expect(accepted).toBe(10);
  });

  it('accepts a bound upload key once under 100 concurrent replay attempts', async () => {
    const [design] = await db.insert(designs).values({niche:'alpine',prompt:'test',provider:'fixture',imageUrl:'/api/preview'}).returning();
    await bindUploadKey(db,'audit-key',design.id);
    const results = await Promise.all(Array.from({length:100},()=>consumeUploadKey(db,'audit-key',design.id)));
    evidence.uploadReplay = {requests:100,accepted:results.filter(Boolean).length};
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await consumeUploadKey(db,'audit-key',design.id)).toBe(false);
  });

  it('atomically counts upscale failures under 20 concurrent reports', async () => {
    const [design] = await db.insert(designs).values({niche:'alpine',prompt:'test',provider:'fixture',imageUrl:'/api/preview'}).returning();
    await Promise.all(Array.from({length:20},()=>recordUpscaleFailure(db,design.id,'synthetic failure')));
    const [row] = await db.select().from(designs).where(eq(designs.id,design.id));
    evidence.upscaleFailure = {reports:20,stored:row.upscaleFailure};
    console.log('AUDIT failure counter',JSON.stringify({reports:20,stored:row.upscaleFailure}));
    expect(row.upscaleFailure!.attempts).toBe(20);
    expect(row.upscaleFailure!.failed).toBe(true);
  });

  it('reports skipped webhook registration honestly', () => {
    const summary = formatMaintenanceSummary(JSON.stringify({webhooks:{existing:0,created:0,skipped:7,reason:'dry-run'},images:{rewritten:0},fakeRows:{orders:0}}));
    expect(summary).toContain('7 skipped (dry-run)');
  });

  it('blocks the write-mode helper while kill switch is on', async () => {
    const oldMode=process.env.PUBLISH_MODE;
    const old=await getSetting(db,'automation');
    try {
      process.env.PUBLISH_MODE='live';
      await setSetting(db,'automation',{...old,publishMode:'live',killSwitch:true});
      expect(await liveWritesEnabled(db)).toBe(false);
    } finally {
      if(oldMode===undefined) delete process.env.PUBLISH_MODE; else process.env.PUBLISH_MODE=oldMode;
      await setSetting(db,'automation',old);
    }
  });
});
