import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity('store_inventory')
export class StoreInventory {
  @PrimaryColumn({ name: 'store_id' })
  storeId: number;

  @PrimaryColumn({ name: 'sku_id' })
  skuId: number;

  @Column({ name: 'on_hand_qty' })
  onHandQty: number;

  @Column({ name: 'reserved_qty' })
  reservedQty: number;

  @Column({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
