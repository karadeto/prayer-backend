import {
    Column,
    Entity,
    Index,
    JoinColumn,
    ManyToOne,
    PrimaryGeneratedColumn,
    Unique,
} from 'typeorm';
import { Location } from './location.entity';

@Entity('prayer_times')
@Unique('uq_prayer_times_location_date', ['locationId', 'prayerDate'])
@Index('ix_prayer_times_location_date', ['locationId', 'prayerDate'])
export class PrayerTime {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: number;

  @Column({ type: 'bigint', name: 'location_id' })
  locationId!: number;

  @Column({ type: 'date', name: 'prayer_date' })
  prayerDate!: string;

  @Column({ type: 'int' })
  @Index()
  year!: number;

  @Column({ type: 'time' })
  fajr!: string;

  @Column({ type: 'time' })
  sunrise!: string;

  @Column({ type: 'time' })
  dhuhr!: string;

  @Column({ type: 'time' })
  asr!: string;

  @Column({ type: 'time' })
  maghrib!: string;

  @Column({ type: 'time' })
  isha!: string;

  @Column({ type: 'varchar', name: 'source_url' })
  sourceUrl!: string;

  @Column({
    type: 'timestamptz',
    name: 'scraped_at',
    default: () => 'now()',
  })
  @Index()
  scrapedAt!: Date;

  @ManyToOne(() => Location, (loc) => loc.prayerTimes, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'location_id' })
  location!: Location;
}
