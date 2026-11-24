import { z } from 'zod';

export const StageStateSchema = z.enum(['pending', 'in_progress', 'done', 'blocked']);

export type StageState = z.infer<typeof StageStateSchema>;

export const SubPhaseStatusSchema = z.enum([
  'not_started',
  'stage1_ready',
  'in_progress',
  'verified',
  'done',
]);

export type SubPhaseStatus = z.infer<typeof SubPhaseStatusSchema>;

export const SubPhaseRecordSchema = z.object({
  id: z.string().regex(/^\d+\.\d+$/),
  title: z.string().min(3).max(160),
  status: SubPhaseStatusSchema,
  stages: z.object({
    stage1ContractsTests: StageStateSchema,
    humanGate: StageStateSchema,
    stage2Implementation: StageStateSchema,
    stage3Verification: StageStateSchema,
  }),
});

export type SubPhaseRecord = z.infer<typeof SubPhaseRecordSchema>;

export const PhaseRecordSchema = z.object({
  id: z.number().int().min(0).max(7),
  name: z.string().min(3).max(160),
  subPhases: z.array(SubPhaseRecordSchema).min(3).max(5),
});

export type PhaseRecord = z.infer<typeof PhaseRecordSchema>;

export const PhaseTrackerSchema = z.object({
  project: z.literal('sunrise'),
  schemaVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  updatedAt: z.string().datetime({ offset: true }),
  activePhase: z.number().int().min(0).max(7),
  phases: z.array(PhaseRecordSchema).length(8),
});

export type PhaseTracker = z.infer<typeof PhaseTrackerSchema>;
