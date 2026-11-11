import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

// Static rider info only. Where a rider IS right now and whether they're free
// changes every few seconds — that lives in Redis (phases 6-7), never here.
@Entity('riders')
export class Rider {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  name: string;

  @Column()
  phone: string;

  @Column({ name: 'home_store_id' })
  homeStoreId: number;

  @Column()
  vehicle: 'bike' | 'ev' | 'cycle';

  @Column({ name: 'is_active' })
  isActive: boolean;
}
