import { MikroOrmModule } from "@mikro-orm/nestjs";
import { Module } from "@nestjs/common";
import { WAGERING_SCHEMAS } from "./infrastructure/persistence/wagering.schemas";

@Module({
  imports: [MikroOrmModule.forFeature(WAGERING_SCHEMAS)],
  exports: [MikroOrmModule],
})
export class WageringModule {}
