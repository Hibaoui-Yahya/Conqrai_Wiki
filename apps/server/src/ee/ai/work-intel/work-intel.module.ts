import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { QueueName } from '../../../integrations/queue/constants';
import { AiProviderModule } from '../providers/ai-provider.module';
import { EmbeddingsModule } from '../embeddings/embeddings.module';
import { IntegrationModule } from '../../../core/integration/integration.module';
import { WorkIntelService } from './work-intel.service';
import { WorkIntelController } from './work-intel.controller';

@Module({
  imports: [
    AiProviderModule,
    EmbeddingsModule,
    // Retrieval authorises the viewer against ConqrPlan, so it needs the
    // Plane client and the delegation minter.
    IntegrationModule,
    BullModule.registerQueue({ name: QueueName.AI_QUEUE }),
  ],
  controllers: [WorkIntelController],
  providers: [WorkIntelService],
  exports: [WorkIntelService],
})
export class WorkIntelModule {}
