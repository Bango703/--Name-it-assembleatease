// ============================================
//  ASSEMBLEATEASE — api.js
//  All Supabase DB operations in one place
// ============================================

const API = {

  // ── PROFILES ────────────────────────────────────────────

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

  // skills filter wired up via Postgres array overlap operator
  async getAssemblers({ search, skills, city, minRate, maxRate, limit = 12, offset = 0 } = {}) {
    try {
      if (!supabaseClient) {
        console.error('ERROR: supabaseClient not initialized in getAssemblers');
        throw new Error('Supabase client not initialized');
      }

      let query = supabaseClient
        .from('profiles')
        .select('*', { count: 'exact' })
        .eq('role', 'assembler')
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1);

      if (search)   query = query.or(`full_name.ilike.%${search}%,bio.ilike.%${search}%`);
      if (city)     query = query.ilike('city', `%${city}%`);
      if (minRate)  query = query.gte('hourly_rate', minRate);
      if (maxRate)  query = query.lte('hourly_rate', maxRate);
      if (skills?.length) query = query.overlaps('skills', skills);

      const { data, error, count } = await query;
      
      if (error) {
        console.error('getAssemblers query error:', error);
      }
      
      return { data, error, count };
    } catch (err) {
      console.error('getAssemblers error:', err);
      return { data: null, error: err, count: 0 };
    }
  },

  // ── JOBS ────────────────────────────────────────────────

  async createJob(jobData) {
    const { data, error } = await supabaseClient
      .from('jobs')
      .insert(jobData)
      .select()
      .single();
    return { data, error };
  },

  // Unified job fetcher — getOpenJobs is just getJobs({ status: 'open' })
  async getJobs({ status, customerId, assemblerId, search, category, limit = 12, offset = 0 } = {}) {
    try {
      if (!supabaseClient) {
        console.error('ERROR: supabaseClient not initialized in API.getJobs');
        throw new Error('Supabase client not initialized');
      }

      let query = supabaseClient
        .from('jobs')
        .select(`
          *,
          customer:profiles!jobs_customer_id_fkey(id, full_name, avatar_url, city),
          bids(count)
        `, { count: 'exact' })
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1);

      if (status)     query = query.eq('status', status);
      if (customerId) query = query.eq('customer_id', customerId);
      if (assemblerId) query = query.eq('assembler_id', assemblerId);
      if (category && category !== 'all') query = query.eq('category', category);
      if (search)     query = query.or(`title.ilike.%${search}%,description.ilike.%${search}%`);

      const { data, error, count } = await query;
      
      if (error) {
        console.error('getJobs query error:', error);
        console.error('Query params:', { status, customerId, assemblerId, search, category });
      }
      
      return { data, error, count };
    } catch (err) {
      console.error('getJobs error:', err);
      return { data: null, error: err, count: 0 };
    }
  },

  // Convenience wrappers
  async getOpenJobs(opts = {}) {
    return this.getJobs({ ...opts, status: 'open' });
  },

  async getCustomerJobs(customerId, opts = {}) {
    return this.getJobs({ ...opts, customerId });
  },

  async getJob(jobId) {
    const { data, error } = await supabaseClient
      .from('jobs')
      .select(`
        *,
        customer:profiles!jobs_customer_id_fkey(id, full_name, avatar_url, city, state, email),
        bids(
          *,
          assembler:profiles!bids_assembler_id_fkey(id, full_name, avatar_url, hourly_rate, rating, completed_jobs, city)
        )
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

  // ── BIDS ────────────────────────────────────────────────

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
        assembler:profiles!bids_assembler_id_fkey(
          id, full_name, avatar_url, hourly_rate, rating, completed_jobs, city, skills, bio
        )
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
        job:jobs(
          id, title, status, budget_min, budget_max, budget_type, category, city, created_at,
          customer:profiles!jobs_customer_id_fkey(full_name, avatar_url)
        )
      `)
      .eq('assembler_id', assemblerId)
      .order('created_at', { ascending: false });
    return { data, error };
  },

  // acceptBid uses a Supabase RPC so the 3 mutations are a single atomic transaction.
  // Create this function in your Supabase SQL editor:
  //
  //   create or replace function accept_bid(
  //     p_bid_id uuid, p_job_id uuid, p_assembler_id uuid, p_agreed_amount numeric
  //   ) returns void language plpgsql as $$
  //   begin
  //     update bids set status = 'accepted' where id = p_bid_id;
  //     update bids set status = 'rejected' where job_id = p_job_id and id <> p_bid_id;
  //     update jobs set status = 'assigned', assembler_id = p_assembler_id,
  //                     agreed_amount = p_agreed_amount where id = p_job_id;
  //   end; $$;
  async acceptBid(bidId, jobId, assemblerId, agreedAmount) {
    const { error } = await supabaseClient.rpc('accept_bid', {
      p_bid_id:       bidId,
      p_job_id:       jobId,
      p_assembler_id: assemblerId,
      p_agreed_amount: agreedAmount,
    });
    return { error };
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

  // ── REVIEWS ─────────────────────────────────────────────

  async getReviews(assemblerId) {
    const { data, error } = await supabaseClient
      .from('reviews')
      .select(`
        *,
        reviewer:profiles!reviews_reviewer_id_fkey(full_name, avatar_url)
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

  // ── DASHBOARD STATS ─────────────────────────────────────

  // Fixed: no longer runs a nested await inside Promise.all.
  // Jobs and bids fetched in parallel using a join instead of two sequential calls.
  async getCustomerStats(customerId) {
    try {
      if (!supabaseClient) {
        console.error('ERROR: supabaseClient not initialized in getCustomerStats');
        throw new Error('Supabase client not initialized');
      }
      
      const [jobsRes, bidsRes] = await Promise.all([
        supabaseClient
          .from('jobs')
          .select('id, status')
          .eq('customer_id', customerId),
        supabaseClient
          .from('bids')
          .select('id, job:jobs!inner(customer_id)')
          .eq('job.customer_id', customerId),
      ]);

      if (jobsRes.error) {
        console.error('Jobs query error in getCustomerStats:', jobsRes.error);
      }
      if (bidsRes.error) {
        console.error('Bids query error in getCustomerStats:', bidsRes.error);
      }

      const jobs = jobsRes.data || [];
      return {
        totalJobs:          jobs.length,
        openJobs:           jobs.filter(j => j.status === 'open').length,
        inProgress:         jobs.filter(j => ['in_progress', 'assigned'].includes(j.status)).length,
        completed:          jobs.filter(j => j.status === 'completed').length,
        totalBidsReceived:  bidsRes.data?.length || 0,
      };
    } catch (err) {
      console.error('getCustomerStats error:', err);
      return { totalJobs: 0, openJobs: 0, inProgress: 0, completed: 0, totalBidsReceived: 0 };
    }
  },

  async getAssemblerStats(assemblerId) {
    const [bidsRes, jobsRes] = await Promise.all([
      supabaseClient.from('bids').select('id, status').eq('assembler_id', assemblerId),
      supabaseClient.from('jobs').select('id, status, agreed_amount').eq('assembler_id', assemblerId),
    ]);

    const allBids = bidsRes.data || [];
    const allJobs = jobsRes.data || [];
    const totalEarned = allJobs
      .filter(j => j.status === 'completed')
      .reduce((sum, j) => sum + (Number(j.agreed_amount) || 0), 0);

    return {
      totalBids:     allBids.length,
      pendingBids:   allBids.filter(b => b.status === 'pending').length,
      acceptedBids:  allBids.filter(b => b.status === 'accepted').length,
      completedJobs: allJobs.filter(j => j.status === 'completed').length,
      totalEarned,
    };
  },
};

window.API = API;