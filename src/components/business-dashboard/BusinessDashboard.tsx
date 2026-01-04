import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { useBusinessDashboard } from './hooks/useBusinessDashboard';
import { BusinessDashboardHero } from './BusinessDashboardHero';
import { BusinessDashboardFilters } from './BusinessDashboardFilters';
import { BusinessKPICards } from './BusinessKPICards';
import { ProbabilitySegmentation } from './ProbabilitySegmentation';
import { GroupSegmentation } from './GroupSegmentation';
import { TimeProjection } from './TimeProjection';
import { ActionableList } from './ActionableList';
import { CohortComparison } from './CohortComparison';
import { WhatIfSimulation } from './WhatIfSimulation';
import { BusinessAIInsights } from './BusinessAIInsights';

interface BusinessDashboardProps {
  projectId: string;
}

export function BusinessDashboard({ projectId }: BusinessDashboardProps) {
  const { t } = useTranslation();
  const [projectInfo, setProjectInfo] = useState<{
    problem_type: string;
    problem_context: string | null;
  } | null>(null);
  
  const { data, filters, updateFilters, loading, error } = useBusinessDashboard(projectId);
  
  useEffect(() => {
    async function fetchProjectInfo() {
      const { data: project } = await supabase
        .from('projects')
        .select('problem_type, detected_problem_type')
        .eq('id', projectId)
        .maybeSingle();
      
      if (project) {
        // Try to infer problem context from project metadata
        setProjectInfo({
          problem_type: project.problem_type,
          problem_context: project.detected_problem_type || null
        });
      }
    }
    
    fetchProjectInfo();
  }, [projectId]);
  
  const problemType = projectInfo?.problem_type || 
    (data.predictions.length > 0 ? data.predictions[0].problem_type : 'classification');
  
  const problemContext = projectInfo?.problem_context || 
    (data.predictions.length > 0 ? data.predictions[0].problem_context : null);

  if (loading && data.predictions.length === 0) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-center py-20">
        <p className="text-destructive">{t('businessDashboard.error')}: {error}</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Hero */}
      <BusinessDashboardHero 
        problemContext={problemContext}
        problemType={problemType}
        horizonDays={filters.horizon}
      />
      
      {/* Filters */}
      <BusinessDashboardFilters 
        filters={filters}
        onFilterChange={updateFilters}
        availableSegmentFields={data.availableSegmentFields}
      />
      
      {/* KPI Cards */}
      <BusinessKPICards 
        kpis={data.kpis}
        problemType={problemType}
        viewMode={filters.viewMode}
      />
      
      {/* Segmentation by Probability */}
      <ProbabilitySegmentation 
        bands={data.segmentationBands}
        problemType={problemType}
        viewMode={filters.viewMode}
      />
      
      {/* Group Segmentation */}
      <GroupSegmentation 
        groups={data.groupSegmentation}
        problemType={problemType}
        availableFields={data.availableSegmentFields}
        currentField={filters.segmentField}
        onFieldChange={(field) => updateFilters({ segmentField: field })}
        viewMode={filters.viewMode}
      />
      
      {/* Time Projection */}
      <TimeProjection 
        projections={data.timeProjections}
        problemType={problemType}
        horizonDays={filters.horizon}
      />
      
      {/* Actionable List */}
      <ActionableList 
        predictions={data.predictions}
        problemType={problemType}
        viewMode={filters.viewMode}
      />
      
      {/* Cohort Comparison */}
      <CohortComparison 
        predictions={data.predictions}
        problemType={problemType}
        availableFields={data.availableSegmentFields}
        viewMode={filters.viewMode}
      />
      
      {/* What-if Simulation */}
      <WhatIfSimulation 
        predictions={data.predictions}
        problemType={problemType}
        viewMode={filters.viewMode}
      />
      
      {/* AI Insights */}
      <BusinessAIInsights 
        projectId={projectId}
        problemType={problemType}
        problemContext={problemContext}
        kpis={data.kpis}
        segmentationBands={data.segmentationBands}
        groupSegmentation={data.groupSegmentation}
        viewMode={filters.viewMode}
      />
    </div>
  );
}
