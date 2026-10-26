export type ArtistPracticeStatus = 'CREATED' | 'VALIDATED' | 'COMPLETED';

export type Practice = {
  id: string;
  artistName: string;
  status: ArtistPracticeStatus;
  createdAt: Date;
  updatedAt: Date;
};
