export interface MusicAdapter {
  createPractice(input: {
    name: string;
    tenantId: string;
    userId: string;
  }): Promise<{ success: boolean }>;

  listPractices(input: {
    tenantId: string;
    userId: string;
  }): Promise<Array<{ name: string; createdAt: Date }>>;

  deletePractice(input: {
    name: string;
    tenantId: string;
    userId: string;
  }): Promise<{ success: boolean }>;

  getContext(input: { tenantId: string; userId: string }): Promise<{
    recentPractices: Array<{ name: string }>;
    totalPractices: number;
  }>;
}
