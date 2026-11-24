import { HeadBucketCommand } from '@aws-sdk/client-s3';

export interface S3CommandSender {
  readonly send: (command: HeadBucketCommand) => Promise<unknown>;
}

export function createS3Probe(
  client: S3CommandSender,
  bucket: string,
  now: () => number = () => Date.now(),
): () => Promise<number> {
  return async (): Promise<number> => {
    const startedAt = now();
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
    return Math.max(0, now() - startedAt);
  };
}
