import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { 
  Search, 
  ChevronRight, 
  FolderKanban,
  AlertTriangle
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { useOrganization } from '@/contexts/OrganizationContext';
import { supabase } from '@/integrations/supabase/client';
import AppShell from '@/components/app/AppShell';

interface ProjectItem {
  id: string;
  name: string;
  description: string | null;
  problem_type: string;
  status: string;
  updated_at: string;
  high_risk_count: number;
}

const AppProjects = () => {
  const navigate = useNavigate();
  const { currentOrganization } = useOrganization();
  const [loading, setLoading] = useState(true);
  const [projects, setProjects] = useState<ProjectItem[]>([]);
  const [search, setSearch] = useState('');

  useEffect(() => {
    const fetchProjects = async () => {
      if (!currentOrganization?.id) {
        setLoading(false);
        return;
      }

      try {
        const { data: projectsData } = await supabase
          .from('projects')
          .select('id, name, description, problem_type, status, updated_at')
          .eq('organization_id', currentOrganization.id)
          .order('updated_at', { ascending: false });

        const projectsWithRisk: ProjectItem[] = [];

        for (const project of projectsData || []) {
          const { data: predState } = await supabase
            .from('project_prediction_state')
            .select('latest_batch_id')
            .eq('project_id', project.id)
            .maybeSingle();
          const batchId = predState?.latest_batch_id;

          const { count: highRiskCount } = await supabase
            .from('predictions')
            .select('*', { count: 'exact', head: true })
            .eq('project_id', project.id)
            .eq(batchId ? 'batch_id' : 'is_latest', batchId || true)
            .gte('probability_event', 0.7);

          projectsWithRisk.push({
            ...project,
            high_risk_count: highRiskCount || 0,
          });
        }

        setProjects(projectsWithRisk);
      } catch (error) {
        console.error('Error fetching projects:', error);
      } finally {
        setLoading(false);
      }
    };

    fetchProjects();
  }, [currentOrganization?.id]);

  const filteredProjects = projects.filter(p => 
    p.name.toLowerCase().includes(search.toLowerCase()) ||
    p.description?.toLowerCase().includes(search.toLowerCase())
  );

  const getProblemTypeLabel = (type: string) => {
    switch (type) {
      case 'classification': return 'Classificação';
      case 'regression': return 'Regressão';
      default: return type;
    }
  };

  const getStatusBadge = (status: string) => {
    const colors: Record<string, string> = {
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
      <Badge variant="secondary" className={colors[status] || 'bg-muted'}>
        {labels[status] || status}
      </Badge>
    );
  };

  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr);
    return date.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' });
  };

  return (
    <AppShell>
      <div className="p-4 pb-8 space-y-4 max-w-lg mx-auto">
        {/* Header */}
        <div className="flex items-center gap-3">
          <FolderKanban className="w-6 h-6 text-primary" />
          <h1 className="text-xl font-bold">Projetos</h1>
        </div>

        {/* Search */}
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            placeholder="Buscar projeto..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-10"
          />
        </div>

        {/* Projects List */}
        {loading ? (
          <div className="space-y-3">
            {[...Array(4)].map((_, i) => (
              <Skeleton key={i} className="h-24 w-full rounded-xl" />
            ))}
          </div>
        ) : filteredProjects.length === 0 ? (
          <Card className="p-8 text-center">
            <FolderKanban className="w-12 h-12 text-muted-foreground mx-auto mb-3" />
            <h3 className="font-semibold mb-1">
              {search ? 'Nenhum projeto encontrado' : 'Sem projetos ainda'}
            </h3>
            <p className="text-sm text-muted-foreground">
              {search 
                ? 'Tente uma busca diferente' 
                : 'Crie projetos no painel web para visualizá-los aqui'}
            </p>
          </Card>
        ) : (
          <div className="space-y-3">
            {filteredProjects.map((project) => (
              <Card 
                key={project.id}
                className="cursor-pointer hover:shadow-md transition-all active:scale-[0.99]"
                onClick={() => navigate(`/app/projeto/${project.id}`)}
              >
                <CardContent className="p-4">
                  <div className="flex items-start justify-between">
                    <div className="flex-1 min-w-0">
                      <h3 className="font-semibold truncate">{project.name}</h3>
                      {project.description && (
                        <p className="text-sm text-muted-foreground truncate mt-0.5">
                          {project.description}
                        </p>
                      )}
                      <div className="flex items-center gap-2 mt-2 flex-wrap">
                        <span className="text-xs text-muted-foreground">
                          {getProblemTypeLabel(project.problem_type)}
                        </span>
                        {getStatusBadge(project.status)}
                        <span className="text-xs text-muted-foreground">
                          {formatDate(project.updated_at)}
                        </span>
                      </div>
                      {project.high_risk_count > 0 && (
                        <div className="flex items-center gap-1.5 mt-2 text-sm text-red-600 font-medium">
                          <AlertTriangle className="w-4 h-4" />
                          <span>{project.high_risk_count.toLocaleString('pt-BR')} em alto risco</span>
                        </div>
                      )}
                    </div>
                    <ChevronRight className="w-5 h-5 text-muted-foreground flex-shrink-0 mt-1" />
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>
    </AppShell>
  );
};

export default AppProjects;
