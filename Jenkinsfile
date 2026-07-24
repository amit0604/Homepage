@Library('panther') _
pipeline {
    agent {
        kubernetes{
            label 'default-pod'
            defaultContainer("jnlp")
        }       
    }

    environment {
        PROJECT_NAME = 'support-center'
        DOCKER_REGISTRY = 'nexus:5012'
    }
    stages {
            
                stage('Get Project Properties') {
                    steps {
                        script {
                            project.get_properties_all()
                        }
                        echo "Starting pipeline for ${PROJECT_NAME}"
                    }
                }
                stage('SonarQube Scan'){
                    steps{
                        container("sonar-scanner"){
                            script {
                                sonarqube.scan(PROJECT_NAME)
                            }
                        }
                    }
                }
                stage('Build Frontend') {
                    steps {
                        container("npm"){

                        dir('frontend') {
                            script {
                                echo "Building frontend for ${PROJECT_NAME}"
                                sh 'npm install'
                                sh 'npm run build'
                            }
                        }
                    }
                    }
                }
                stage('Docker build and push ...') {
                    steps {
                        container("kaniko"){
                            script{ 
                                    kaniko.buildNpush "${env.IMAGE_NAME.toLowerCase()}"            
                                
                            }
                        }
                    }
                }
                stage('trivy vulnerability scan') {
                    steps {
                        script {
                            container("trivy") {
                                trivy.scan(env.IMAGE_NAME.toLowerCase())
                
                            }
                        }
                    }
                }
                stage('Update GitOps Helm Chart') {
    steps {
        script {
            def defaultGitopsUrl = 'https://gitlab.example.com/sharatim/kubernetes/gitops/support-center-gitops.git'
            def gitopsCloneUrl = env.GITOPS_REPO_URL ?: defaultGitopsUrl
            def gitopsUri = new java.net.URI(gitopsCloneUrl)
            def gitopsCredHostPath = "${gitopsUri.authority}${gitopsUri.path}"

            // Step 0: Clone the GitLab repo
            dir('support-center-gitops') {
                git branch: 'main',
                    url: gitopsCloneUrl,
                    credentialsId: 'svc_jenkins'
            }

            // Step 1: Read image tag from env
            def imageTag = env.IMAGE_NAME.split(':')[-1]

            // Step 2: Update Chart.yaml
            def chartYaml = readFile('support-center-gitops/helm/Chart.yaml')
            chartYaml = chartYaml.replaceAll(/version: .*/, "version: ${imageTag}")
            writeFile file: 'support-center-gitops/helm/Chart.yaml', text: chartYaml

            // Step 3: Update values.yaml
            def valuesYaml = readFile('support-center-gitops/helm/values.yaml')
            valuesYaml = valuesYaml.replaceAll(/tag:\s+.*/, "tag: ${imageTag}")
            writeFile file: 'support-center-gitops/helm/values.yaml', text: valuesYaml

            // Step 4: Read version from package.json (optional)
            def packageJson = readFile('frontend/package.json')
            def packageVersion = new groovy.json.JsonSlurper().parseText(packageJson).version
            echo "Package.json version: ${packageVersion}"

            // Step 5: Compare Helm chart version with package.json version
            if (imageTag == packageVersion) {
                echo "Versions match. Proceeding to commit and push changes to GitOps repo."

                // Step 6: Git add, commit, and push
                dir('support-center-gitops') {
                    withCredentials([usernamePassword(credentialsId:'gitops',usernameVariable:'GIT_USER',passwordVariable:'GIT_PASS')]){
                    sh 'git config user.email "jenkins@example.com"'
                    sh 'git config user.name "Jenkins_CI"'           
                    sh 'git add helm/Chart.yaml helm/values.yaml'
                    sh "git commit -m \"Update Helm chart version to ${imageTag}\""
                    sh "git remote set-url origin https://\$GIT_USER:\$GIT_PASS@${gitopsCredHostPath}"
                    sh 'git push origin main'
                    }
                    
                }
            } else {
                error "Mismatch between Helm chart version (${imageTag}) and package.json version (${packageVersion})."
            }
        }
    }
}
            
        }
        
}
