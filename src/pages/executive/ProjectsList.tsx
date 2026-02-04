import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, ChevronRight, AlertTriangle } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { useOrganization } from '@/contexts/OrganizationContext';
import { supabase } from '@/integrations/supabase/client';
import AppShell from '@/components/executive/AppShell';

interface ProjectSummary {
  id: string;
  name: string;
  problem_type: string;
  status: string;
  high_risk_count: number;
  updated_at: string;
}

const ProjectsList = () => {
  const navigate = useNavigate();
  const { currentOrganization } = useOrganization();
  const [loading, setLoading] = useState(true);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [searchQuery, setSearchQuery] = useState('');

  useEffect(() => {
    const fetchProjects = async () => {
      if (!currentOrganization?.id) {
        setLoading(false);
        return;
      }

      setLoading(true);
      try {
        const { data: projectsData } = await supabase
          .from('projects')
          .select('id, name, problem_type, status, updated_at')
          .eq('organization_id', currentOrganization.id)
          .order('updated_at', { ascending: false });

        const summaries: ProjectSummary[] = [];
        
        for (const project of projectsData || []) {
          const { count: highRiskCount } = await supabase
            .from('predictions')
            .select('*', { count: 'exact', head: true })
            .eq('project_id', project.id)
            .eq('is_latest', true)
            .gte('probability_event', 0.7);

          summaries.push({
            ...project,
            high_risk_count: highRiskCount || 0,
          });
        }

        setProjects(summaries);
      } catch (error) {
        console.error('Error fetching projects:', error);
      } finally {
        setLoading(false);
      }
    };

    fetchProjects();
  }, [currentOrganization?.id]);

  const filteredProjects = projects.filter((p) =>
    p.name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const getStatusBadge = (status: string) => {
    const styles: Record<string, string> = {
      draft: 'bg-muted text-muted-foreground',
      data_ready: 'bg-blue-500/10 text-blue-600',
      trained: 'bg-green-500/10 text-green-600',
      deployed: 'bg-purple-500/10 text-purple-600',
    };
    const labels: Record<string, string> = {
      draft: 'Rascunho',
      data_ready: 'Dados OK',
      trained: 'Treinado',
      deployed: 'Em Produção',
    };
    return (
      <Badge variant="secondary" className={styles[status] || styles.draft}>
        {labels[status] || status}
      </Badge>
    );
  };

  const formatDate = (date: string) => {
    return new Date(date).toLocaleDateString('pt-BR', {
      day: '2-digit',
      month: 'short',
    });
  };

  return (
    <AppShell>
      <div className="p-4 space-y-4">
        {/* Search */}
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-muted-foreground" />
          <Input
            placeholder="Buscar projeto..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-10 h-12 text-base"
          />
        </div>

        {/* Projects list */}
        {loading ? (
          <div className="space-y-3">
            {[...Array(5)].map((_, i) => (
              <Skeleton key={i} className="h-24 w-full rounded-xl" />
            ))}
          </div>
        ) : filteredProjects.length === 0 ? (
          <div className="text-center py-12">
            <p className="text-muted-foreground">
              {searchQuery ? 'Nenhum projeto encontrado' : 'Nenhum projeto ainda'}
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {filteredProjects.map((project) => (
              <button
                key={project.id}
                onClick={() => navigate(`/executivo/projeto/${project.id}`)}
                className="w-full bg-card rounded-xl p-4 border shadow-sm hover:shadow-md transition-all active:scale-[0.99] text-left"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <h3 className="font-semibold text-foreground truncate mb-1">
                      {project.name}
                    </h3>
                    <div className="flex items-center gap-2 flex-wrap">
                      {getStatusBadge(project.status)}
                      <span className="text-xs text-muted-foreground">
                        Atualizado {formatDate(project.updated_at)}
                      </span>
                    </div>
                    
                    {project.high_risk_count > 0 && (
                      <div className="flex items-center gap-1.5 mt-2 text-destructive">
                        <AlertTriangle className="w-4 h-4" />
                        <span className="text-sm font-medium">
                          {project.high_risk_count.toLocaleString('pt-BR')} em alto risco
                        </span>
                      </div>
                    )}
                  </div>
                  <ChevronRight className="w-5 h-5 text-muted-foreground flex-shrink-0 mt-1" />
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </AppShell>
  );
};

export default ProjectsList;
