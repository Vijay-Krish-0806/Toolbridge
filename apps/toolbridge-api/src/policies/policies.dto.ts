import { IsObject } from 'class-validator';

/** The policy document (the same format as specs/host-store.policy.json); checked by parsePolicy. */
export class SetPolicyDto {
  @IsObject()
  policy!: Record<string, unknown>;
}
