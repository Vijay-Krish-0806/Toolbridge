import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export const FIELD_TYPES = ['string', 'integer', 'enum', 'array'] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export class LookupDto {
  @ApiProperty({ example: 'GET' })
  method!: string;

  @ApiProperty({ description: 'Endpoint that lists valid values.', example: '/customers?search=' })
  path!: string;

  @ApiProperty({ description: 'Field of each result to use as the value.', example: '_id' })
  valueField!: string;
}

export class FormFieldDto {
  @ApiProperty({ example: 'couponCode' })
  name!: string;

  @ApiProperty({ example: 'Coupon code' })
  label!: string;

  @ApiProperty({ enum: FIELD_TYPES })
  type!: FieldType;

  @ApiProperty()
  required!: boolean;

  @ApiProperty({ example: 'Only coupons usable right now are listed.' })
  description!: string;

  @ApiPropertyOptional({ type: [String], description: 'Allowed values, for enum fields.' })
  options?: string[];

  @ApiPropertyOptional({ description: 'Minimum value or item count.' })
  min?: number;

  @ApiPropertyOptional({ description: 'Maximum value, length or item count.' })
  max?: number;

  @ApiPropertyOptional({ type: LookupDto, description: 'Where to find valid values.' })
  lookup?: LookupDto;

  @ApiPropertyOptional({
    type: () => [FormFieldDto],
    description: 'For array fields: the fields of each item.',
  })
  itemFields?: FormFieldDto[];
}

class SubmitDto {
  @ApiProperty({ example: 'POST' })
  method!: string;

  @ApiProperty({ example: '/orders' })
  path!: string;
}

export class FormDto {
  @ApiProperty({ example: 'order.create' })
  formId!: string;

  @ApiProperty({ example: 'Create an order' })
  title!: string;

  @ApiProperty({ type: SubmitDto, description: 'Send the filled-in fields as JSON here.' })
  submit!: SubmitDto;

  @ApiProperty({ format: 'date-time', description: 'Options are valid as of this time.' })
  generatedAt!: string;

  @ApiProperty({ type: [FormFieldDto] })
  fields!: FormFieldDto[];
}
