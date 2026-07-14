// AssembleAtEase browser API surface.
// Sensitive booking, dispatch, review, and payment mutations stay behind
// authenticated server endpoints. The only direct profile write uses the
// auth-bound, field-allowlisted RPC from migration 031/037.

const API = {
  async updateProfile(userId, updates) {
    const { data: { user } = {} } = await supabaseClient.auth.getUser();
    if (!user || user.id !== userId) {
      return { data: null, error: new Error('Profile ownership could not be verified') };
    }
    const { data, error } = await supabaseClient
      .rpc('update_own_easer_profile', { p_updates: updates });
    return { data: Array.isArray(data) ? (data[0] || null) : data, error };
  },

  async getReviews() {
    const { data: { session } } = await supabaseClient.auth.getSession();
    if (!session?.access_token) {
      return { data: null, error: new Error('Authentication required') };
    }
    try {
      const response = await fetch('/api/assembler/reviews', {
        headers: { Authorization: 'Bearer ' + session.access_token },
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'Could not load reviews');
      return {
        data: (payload.reviews || []).map(review => ({
          rating: review.rating,
          comment: review.comment,
          customer_would_rehire: review.customerWouldRehire,
          created_at: review.createdAt,
          reviewer: { full_name: review.customerFirstName || 'Customer' },
        })),
        error: null,
      };
    } catch (error) {
      return { data: null, error };
    }
  },
};

window.API = API;
