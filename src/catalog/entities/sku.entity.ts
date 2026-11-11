import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('skus')
export class Sku {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  code: string;

  @Column()
  name: string;

  @Column()
  category: string;

  @Column({ name: 'pack_size' })
  packSize: string;

  @Column({ name: 'mrp_paise' })
  mrpPaise: number;

  @Column({ name: 'rx_required' })
  rxRequired: boolean;

  @Column({ name: 'cold_chain' })
  coldChain: boolean;

  @Column({ name: 'is_active' })
  isActive: boolean;
}
