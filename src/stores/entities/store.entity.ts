import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { Point, Polygon } from 'geojson';

@Entity('stores')
export class Store {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  code: string;

  @Column()
  name: string;

  @Column()
  area: string;

  @Column({ type: 'geography', spatialFeatureType: 'Point', srid: 4326 })
  location: Point;

  @Column({ name: 'service_area', type: 'geography', spatialFeatureType: 'Polygon', srid: 4326 })
  serviceArea: Polygon;

  @Column({ name: 'is_active' })
  isActive: boolean;

  @Column({ name: 'max_orders_per_hour' })
  maxOrdersPerHour: number;

  @Column({ name: 'opens_at', type: 'time' })
  opensAt: string;

  @Column({ name: 'closes_at', type: 'time' })
  closesAt: string;
}
