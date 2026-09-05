import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { QueueJob, QueueName } from '../../../integrations/queue/constants';

/**
 * Schedules the delivery-projection reconciliation sweep.
 *
 * Registered on the shared general queue with a fixed `jobId`, the same way
 * the doc-health jobs are: BullMQ then treats repeated registrations as one
 * repeatable job, so every application instance can call this on boot and only
 * one sweep is ever scheduled. That is the single-run protection — there is no
 * separate lock to maintain.
 */

const RECONCILE_JOB_ID = 'delivery-projection-reconcile-cron';

/**
 * Every 15 minutes.
 *
 * The projection's own freshness window is 5 minutes, and the read path
 * repairs anything a user actually looks at, so this sweep exists for the rows
 * nobody is looking at — where being an hour behind costs nothing but being a
 * day behind is a stale dashboard. Quarter-hourly keeps the worst case small
 * while staying far below ConqrPlan's rate limit.
 */
const RECONCILE_CRON = '*/15 * * * *';

@Injectable()
export class DeliveryReconciliationCronService implements OnModuleInit {
  private readonly logger = new Logger(DeliveryReconciliationCronService.name);

  constructor(
    @InjectQueue(QueueName.GENERAL_QUEUE) private readonly generalQueue: Queue,
  ) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.generalQueue.add(
        QueueJob.DELIVERY_PROJECTION_RECONCILE,
        {},
        {
          repeat: { pattern: RECONCILE_CRON },
          jobId: RECONCILE_JOB_ID,
          // Retry a failed sweep a couple of times with backoff. Beyond that
          // the next scheduled run will pick the same rows up anyway, so
          // retrying harder buys nothing.
          attempts: 3,
          backoff: { type: 'exponential', delay: 30_000 },
          removeOnComplete: { count: 50 },
          // Failures are kept: they are the dead-letter record an operator
          // inspects after a ConqrPlan outage.
          removeOnFail: { count: 50 },
        },
      );
    } catch (err) {
      // A scheduling failure must not stop the app from booting; the sweep is
      // a background repair, not a request path.
      const message = err instanceof Error ? err.message : 'Unknown error';
      this.logger.error(
        `Failed to schedule delivery reconciliation: ${message}`,
      );
    }
  }
}
