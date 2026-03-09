import {
    Column,
    CreateDateColumn,
    Entity,
    Index,
    OneToMany,
    PrimaryGeneratedColumn,
    Unique,
    UpdateDateColumn,
} from 'typeorm';
import { PrayerTime } from './prayer-time.entity';

@Entity('locations')
@Unique('uq_locations_diyanet_location_id', ['diyanetLocationId'])
export class Location {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: number;

  @Column({ type: 'int', name: 'diyanet_location_id' })
  @Index()
  diyanetLocationId!: number;

  @Column({ type: 'varchar', length: 16, default: 'tr-TR' })
  locale!: string;

  @Column({ type: 'varchar', length: 255 })
  slug!: string;

  @Column({ type: 'varchar', length: 255, name: 'display_name' })
  displayName!: string;

  @Column({ type: 'varchar', length: 120, nullable: true, name: 'country_name' })
  countryName!: string | null;

  @Column({ type: 'varchar', length: 120, nullable: true, name: 'city_name' })
  cityName!: string | null;

  @Column({ type: 'varchar', length: 120, nullable: true, name: 'district_name' })
  districtName!: string | null;

  @Column({ type: 'float', nullable: true })
  latitude!: number | null;

  @Column({ type: 'float', nullable: true })
  longitude!: number | null;

  @Column({
    type: 'geometry',
    spatialFeatureType: 'Point',
    srid: 4326,
    nullable: true,
  })
  @Index('ix_locations_geom', { spatial: true })
  geom!: object | null;

  @Column({ type: 'varchar', length: 64, default: 'Europe/Istanbul' })
  timezone!: string;

  @Column({ type: 'varchar', length: 512, name: 'source_url' })
  sourceUrl!: string;

  @Column({
    type: 'timestamptz',
    nullable: true,
    name: 'source_lastmod',
  })
  sourceLastmod!: Date | null;

  @Column({ type: 'boolean', default: true, name: 'is_active' })
  isActive!: boolean;

  @Column({ type: 'boolean', default: false, name: 'is_hot' })
  isHot!: boolean;

  @Column({ type: 'float', nullable: true, name: 'geocode_confidence' })
  geocodeConfidence!: number | null;

  @Column({ type: 'varchar', length: 512, nullable: true, name: 'geocode_query' })
  geocodeQuery!: string | null;

  @Column({ type: 'boolean', default: false, name: 'geocode_verified' })
  geocodeVerified!: boolean;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;

  @OneToMany(() => PrayerTime, (pt) => pt.location, { cascade: true })
  prayerTimes!: PrayerTime[];
}
