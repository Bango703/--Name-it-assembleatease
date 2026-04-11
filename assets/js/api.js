// ============================================
//  ASSEMBLEATEASE — api.js
//  All Supabase DB operations in one place
// ============================================

const API = {

  // ── PROFILES ──────────────────────────────

  async getProfile(userId) {
    const { data, error } = await supabaseClient
      .from('profiles')
      .select('*')
      .eq('id', userId)
      .single();
    return { data, error };
  },

  async updateProfile(userId, updates) {
    const { data, error } = await supabaseClient
      .from('profiles')
      .update(updates)
      .eq('id', userId)
      .select()
      .single();
    return { data, error };
  },

  async getAssemblers({ search, skills, city, minRate, maxRate, limit = 12, offset = 0 } = {}) {
    let query = supabaseClient
      .from('profiles')
      .select('*')
      .eq('role', 'assembler')
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (search) {
      query = query.or(`full_name.ilike.%${search}%,bio.ilike.%${search}%`);
    }
    if (city)    query = query.ilike('city', `%${city}%`);
    if (minRate) query = query.gte('hourly_rate', minRate);
    if (maxRate) query = query.lte('hourly_rate', maxRate);

    const { data, error, count } = await query;
    return { data, error, count };
  },

  // ── JOBS ──────────────────────────────────

  async createJob(jobData) {
    const { data, error } = await supabaseClient
      .from('jobs')
      .insert(jobData)
      .select()
      .single();
    return { data, error };
  },

  async getJobs({ status, customerId, search, category, limit = 12, offset = 0 } = {}) {
    let query = supabaseClient
      .from('jobs')
      .select(`
        *,
        customer:profiles!jobs_customer_id_fkey(id, full_name, city),
        bids(count)
      `)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (status)     query = query.eq('status', status);
    if (customerId) query = query.eq('customer_id', customerId);
    if (category)   query = query.eq('category', category);
    if (search) {
      query = query.or(`title.ilike.%${search}%,description.ilike.%${search}%`);
    }

    const { data, error } = await query;
    return { data, error };
  },

  async getJob(jobId) {
    const { data, error } = await supabaseClient
      .from('jobs')
      .select(`
        *,
        customer:profiles!jobs_customer_id_fkey(id, full_name, city, state, email),
        bids(*, assembler:profiles!bids_assembler_id_fkey(id, full_name, hourly_rate, rating, completed_jobs, city))
      `)
      .eq('id', jobId)
      .single();
    return { data, error };
  },

  async updateJob(jobId, updates) {
    const { data, error } = await supabaseClient
      .from('jobs')
      .update(updates)
      .eq('id', jobId)
      .select()
      .single();
    return { data, error };
  },

  async deleteJob(jobId) {
    const { error } = await supabaseClient
      .from('jobs')
      .delete()
      .eq('id', jobId);
    return { error };
  },

  async getOpenJobs({ search, category, limit = 12, offset = 0 } = {}) {
    let query = supabaseClient
      .from('jobs')
      .select(`
        *,
        customer:profiles!jobs_customer_id_fkey(id, full_name, city),
        bids(count)
      `)
      .eq('status', 'open')
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (category && category !== 'all') query = query.eq('category', category);
    if (search) {
      query = query.or(`title.ilike.%${search}%,description.ilike.%${search}%`);
    }

    const { data, error } = await query;
    return { data, error };
  },

  // ── BIDS ──────────────────────────────────

  async submitBid(bidData) {
    const { data, error } = await supabaseClient
      .from('bids')
      .insert(bidData)
      .select()
      .single();
    return { data, error };
  },

  async getBidsForJob(jobId) {
    const { data, error } = await supabaseClient
      .from('bids')
      .select(`
        *,
        assembler:profiles!bids_assembler_id_fkey(id, full_name, hourly_rate, rating, completed_jobs, city, skills, bio)
      `)
      .eq('job_id', jobId)
      .order('created_at', { ascending: false });
    return { data, error };
  },

  async getMyBids(assemblerId) {
    const { data, error } = await supabaseClient
      .from('bids')
      .select(`
        *,
        job:jobs(id, title, status, budget_min, budget_max, budget_type, category, city, created_at,
          customer:profiles!jobs_customer_id_fkey(full_name))
      `)
      .eq('assembler_id', assemblerId)
      .order('created_at', { ascending: false });
    return { data, error };
  },

  async acceptBid(bidId, jobId, assemblerId, agreedAmount) {
    // Accept this bid
    const { error: bidError } = await supabaseClient
      .from('bids')
      .update({ status: 'accepted' })
      .eq('id', bidId);
    if (bidError) return { error: bidError };

    // Reject all other bids for this job
    await supabaseClient
      .from('bids')
      .update({ status: 'rejected' })
      .eq('job_id', jobId)
      .neq('id', bidId);

    // Update job status
    const { error: jobError } = await supabaseClient
      .from('jobs')
      .update({ status: 'assigned', assembler_id: assemblerId, agreed_amount: agreedAmount })
      .eq('id', jobId);

    return { error: jobError };
  },

  async withdrawBid(bidId) {
    const { error } = await supabaseClient
      .from('bids')
      .update({ status: 'withdrawn' })
      .eq('id', bidId);
    return { error };
  },

  async hasAlreadyBid(jobId, assemblerId) {
    const { data } = await supabaseClient
      .from('bids')
      .select('id')
      .eq('job_id', jobId)
      .eq('assembler_id', assemblerId)
      .maybeSingle();
    return !!data;
  },

  // ── REVIEWS ───────────────────────────────

  async getReviews(assemblerId) {
    const { data, error } = await supabaseClient
      .from('reviews')
      .select(`
        *,
        reviewer:profiles!reviews_reviewer_id_fkey(full_name)
      `)
      .eq('assembler_id', assemblerId)
      .order('created_at', { ascending: false });
    return { data, error };
  },

  async createReview(reviewData) {
    const { data, error } = await supabaseClient
      .from('reviews')
      .insert(reviewData)
      .select()
      .single();
    return { data, error };
  },

  // ── DASHBOARD STATS ───────────────────────

  async getCustomerStats(customerId) {
    const [jobsRes, bidsRes] = await Promise.all([
      supabaseClient.from('jobs').select('id, status').eq('customer_id', customerId),
      supabaseClient.from('bids')
        .select('id')
        .in('job_id',
          (await supabaseClient.from('jobs').select('id').eq('customer_id', customerId)).data?.map(j => j.id) || []
        )
    ]);

    const jobs = jobsRes.data || [];
    return {
      totalJobs:     jobs.length,
      openJobs:      jobs.filter(j => j.status === 'open').length,
      inProgress:    jobs.filter(j => j.status === 'in_progress' || j.status === 'assigned').length,
      completed:     jobs.filter(j => j.status === 'completed').length,
      totalBidsReceived: bidsRes.data?.length || 0,
    };
  },

  async getAssemblerStats(assemblerId) {
    const { data: bids } = await supabaseClient
      .from('bids')
      .select('id, status')
      .eq('assembler_id', assemblerId);

    const { data: jobs } = await supabaseClient
      .from('jobs')
      .select('id, status, agreed_amount')
      .eq('assembler_id', assemblerId);

    const allBids = bids || [];
    const allJobs = jobs || [];

    const earned = allJobs
      .filter(j => j.status === 'completed')
      .reduce((sum, j) => sum + (j.agreed_amount || 0), 0);

    return {
      totalBids:    allBids.length,
      pendingBids:  allBids.filter(b => b.status === 'pending').length,
      acceptedBids: allBids.filter(b => b.status === 'accepted').length,
      completedJobs: allJobs.filter(j => j.status === 'completed').length,
      totalEarned:  earned,
    };
  },
};

window.API = API;

