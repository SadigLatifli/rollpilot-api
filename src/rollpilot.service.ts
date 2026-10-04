import { BadRequestException, HttpException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { AnalyzeDto, EmbedImageDto, EmbedTextDto, ConfirmPlanDto, CreatePlanDto } from './dto';
import { EmbeddingService } from './embedding.service';
import { AiAnalysisService } from './ai-analysis.service';
import type { Activity, AgentPlan, Collection, Session } from './models';
import { StoreService } from './store.service';

@Injectable()
export class RollpilotService {
  private readonly analysisBySession = new Map<string, { count: number; until: number }>();
  constructor(private readonly store: StoreService, private readonly analysis: AiAnalysisService, private readonly embeddings: EmbeddingService) {}

  state(hash: string) {
    return this.store.getSession(hash);
  }

  collection(hash: string, id: string): Collection {
    const item = this.store.getSession(hash)?.collections.find(collection => collection.id === id);
    if (!item) throw new NotFoundException('Collection not found');
    return item;
  }

  async setOnboarded(hash: string, onboarded: boolean) {
    return this.store.updateSession(hash, session => {
      session.onboarded = onboarded;
      return { onboarded };
    });
  }

  async createPlan(hash: string, input: CreatePlanDto): Promise<AgentPlan> {
    const ids = input.groups.map(group => group.id);
    if (new Set(ids).size !== ids.length) throw new BadRequestException('Group IDs must be unique');
    if (input.groups.some(group => group.assetIds && (group.assetIds.length !== group.count || new Set(group.assetIds).size !== group.assetIds.length || (group.coverAssetId && !group.assetIds.includes(group.coverAssetId))))) {
      throw new BadRequestException('Group count must match unique asset IDs');
    }
    return this.store.updateSession(hash, session => {
      const plan: AgentPlan = { ...input, id: randomUUID(), groups: input.groups.map(group => ({ ...group })) };
      session.currentPlan = plan;
      return plan;
    });
  }

  private readonly embeddingBudgets = new Map<string, { count: number; until: number }>();
  async embed(hash: string, input: EmbedImageDto | EmbedTextDto) {
    const image = 'thumbnail' in input;
    const now = Date.now();
    for (const [key, bucket] of this.embeddingBudgets) if (bucket.until <= now) this.embeddingBudgets.delete(key);
    const key = `${hash}:${image ? 'image' : 'text'}`;
    const bucket = this.embeddingBudgets.get(key) ?? { count: 0, until: now + 3_600_000 };
    if (bucket.count >= (image ? 1200 : 300)) throw new HttpException('Embedding limit reached. Saved results remain available; resume in an hour.', 429);
    bucket.count++;
    this.embeddingBudgets.set(key, bucket);
    return image ? this.embeddings.image(input as EmbedImageDto) : this.embeddings.text((input as EmbedTextDto).text);
  }

  embeddingDiagnostics() { return this.embeddings.diagnostics(); }

  async analyze(hash: string, input: AnalyzeDto) {
    const now = Date.now();
    const bucket = this.analysisBySession.get(hash);
    const current = bucket && bucket.until > now ? bucket : { count: 0, until: now + 3_600_000 };
    if (current.count >= 20) throw new HttpException('AI request limit reached. Try again in an hour.', 429);
    current.count++;
    this.analysisBySession.set(hash, current);
    let analysis: Awaited<ReturnType<AiAnalysisService['analyze']>>;
    try { analysis = await this.analysis.analyze(input); }
    catch (error) {
      current.count = Math.max(0, current.count - 1);
      throw error;
    }
    const count = analysis.groups.reduce((sum, group) => sum + group.assetIds.length, 0);
    const scanned = `${input.candidates.length} candidate ${input.candidates.length === 1 ? 'photo' : 'photos'} considered`;
    if (!count) return { plan: null, headline: 'No matching candidates found', scanned };
    const candidates = new Map(input.candidates.map(candidate => [candidate.assetId, candidate]));
    const tints = ['#E8C3A5', '#C6DAE4', '#E6CBCD', '#E7DCAF', '#C6D9C4'];
    const headline = analysis.kind === 'cleanup' ? `${count} cleanup candidates to review` : analysis.kind === 'organize' ? `${count} photos ready to organize` : `${count} matching photos found`;
    const plan = await this.createPlan(hash, {
      kind: analysis.kind,
      command: input.command,
      headline,
      detail: analysis.kind === 'cleanup' ? 'Review each item before deciding what to remove.' : 'Review these matches from the supplied candidates.',
      scanned,
      groups: analysis.groups.map((group, index) => ({
        id: `group-${index + 1}`,
        title: group.title,
        count: group.assetIds.length,
        assetIds: group.assetIds,
        coverAssetId: group.assetIds[0],
        photo: candidates.get(group.assetIds[0])?.previewKey ?? 'cafe',
        tint: tints[index % tints.length],
      })),
    });
    return { plan };
  }

  async confirmPlan(hash: string, planId: string, input: ConfirmPlanDto) {
    return this.store.updateSession(hash, session => {
      const plan = session.currentPlan;
      if (!plan || plan.id !== planId) throw new NotFoundException('Plan not found');
      if (plan.kind === 'find') throw new BadRequestException('Find plans cannot be confirmed');

      let count = 0;
      let collections: Collection[] = [];
      if (plan.kind === 'organize') {
        collections = plan.groups.map(group => ({
          id: `${plan.id}-${group.id}`,
          title: group.title,
          count: group.count,
          unit: 'photos',
          photos: [group.photo, group.photo, group.photo],
          tint: group.tint,
          icon: 'albums-outline',
          auto: true,
          ...(group.assetIds ? { assetIds: group.assetIds } : {}),
          ...(group.coverAssetId ? { coverAssetId: group.coverAssetId } : {}),
        }));
        count = collections.reduce((sum, collection) => sum + collection.count, 0);
        const titles = new Set(collections.map(collection => collection.title.toLowerCase()));
        session.collections = [...collections, ...session.collections.filter(collection => !titles.has(collection.title.toLowerCase()))];
        this.record(session, plan.id, collections.length === 1 ? `Created “${collections[0].title}”` : `Created ${collections.length} collections`, `${count.toLocaleString()} items`, 'albums-outline');
      } else {
        const groupIds = new Set(input.selectedGroupIds ?? []);
        const itemIds = new Set(input.selectedItemIds ?? []);
        const assetIds = new Set(input.selectedAssetIds ?? []);
        const knownGroups = new Set(plan.groups.map(group => group.id));
        const knownAssets = new Set(plan.groups.flatMap(group => group.assetIds ?? []));
        if ([...groupIds].some(id => !knownGroups.has(id)) || [...itemIds].some(id => {
          const match = /^(.+):([0-2])$/.exec(id);
          return !match || !knownGroups.has(match[1]) || !!plan.groups.find(group => group.id === match[1])?.assetIds;
        }) || [...assetIds].some(id => !knownAssets.has(id))) throw new BadRequestException('Unknown selection');
        for (const group of plan.groups) if (groupIds.has(group.id) && group.assetIds) group.assetIds.forEach(id => assetIds.add(id));
        count = assetIds.size + plan.groups.reduce((sum, group) => sum + (group.assetIds ? 0 : groupIds.has(group.id) ? group.count : [0, 1, 2].filter(index => itemIds.has(`${group.id}:${index}`)).length), 0);
        if (!count) throw new BadRequestException('Select at least one item');
        this.record(session, plan.id, 'Reviewed screenshot cleanup', `${count.toLocaleString()} items selected · no device photos deleted`, 'checkmark-circle-outline');
        session.currentPlan = null;
        return { count, selectedAssetIds: [...assetIds], collections: [], activity: session.activities[0] };
      }
      session.currentPlan = null;
      return { count, collections, activity: session.activities[0] };
    });
  }

  private record(session: Session, id: string, title: string, detail: string, icon: string) {
    const activity: Activity = { id, title, detail, icon, occurredAt: new Date().toISOString() };
    session.activities.unshift(activity);
  }
}
