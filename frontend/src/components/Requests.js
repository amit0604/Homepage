import React, { useState, useEffect, useMemo, useRef } from 'react';
import { jwtDecode } from 'jwt-decode'; // ✅ Add this
import { isJwtExpired } from '../utils/jwtSession';
import {
  PHONE_KIND_MOBILE,
  PHONE_KIND_INTERNAL,
  displayPhoneFromTicket,
  formStateFromTicket,
  isPhoneFormValid,
  buildPhoneApiBody,
} from '../utils/ticketPhone';
import {
  formatCreatorTableCell,
  formatCreatorPreviewLine,
  formatCreatorTooltip,
} from '../utils/ticketUserDisplay';
import { userDisplayName } from '../utils/userDisplayName';

function userTicketStatusClass(status) {
  const s = String(status || '').trim().toLowerCase();
  if (s === 'pending') return 'admin-status-pill--pending';
  if (s === 'in progress') return 'admin-status-pill--in-progress';
  if (s === 'closed') return 'admin-status-pill--closed';
  return 'admin-status-pill--default';
}

const UserDashboard = () => {
    const [requests, setRequests] = useState([]);
    const [selectedRequest, setSelectedRequest] = useState(null);
    const [title, setTitle] = useState('');
    const [description, setDescription] = useState('');
    const [phoneNumber, setPhoneNumber] = useState('');
    const [phoneKind, setPhoneKind] = useState(PHONE_KIND_MOBILE);
    const [department, setDepartment] = useState('');
    const [departments, setDepartments] = useState([]);
    const [status, setStatus] = useState('pending'); 
    const [commentText, setCommentText] = useState('');
    const [user, setUser] = useState({});
    const [isViewModalOpen, setIsViewModalOpen] = useState(false);
    const [isEditModalOpen, setIsEditModalOpen] = useState(false);
    const [isCommentModalOpen, setIsCommentModalOpen] = useState(false);
    const [error, setError] = useState(null);
    const [successMessage, setSuccessMessage] = useState(null);
    const [currentView, setCurrentView] = useState('pending');
    const [myRequestsQuery, setMyRequestsQuery] = useState('');
    const viewModalRef = useRef(null);
    const editModalRef = useRef(null);
    const commentModalRef = useRef(null);
useEffect(() => {
    if (isViewModalOpen) {
      const handleClickOutside = (event) => {
        if (
          viewModalRef.current &&
          !viewModalRef.current.contains(event.target)
        ) {
          setIsViewModalOpen(false);
        }
      };
      document.addEventListener("mousedown", handleClickOutside);
      return () => {
        document.removeEventListener("mousedown", handleClickOutside);
      };
    }
  }, [isViewModalOpen]);
  
  useEffect(() => {
    if (isEditModalOpen) {
      const handleClickOutside = (event) => {
        if (
          editModalRef.current &&
          !editModalRef.current.contains(event.target)
        ) {
          setIsEditModalOpen(false);
        }
      };
      document.addEventListener("mousedown", handleClickOutside);
      return () => {
        document.removeEventListener("mousedown", handleClickOutside);
      };
    }
  }, [isEditModalOpen]);
  
  useEffect(() => {
    if (isCommentModalOpen) {
      const handleClickOutside = (event) => {
        if (
          commentModalRef.current &&
          !commentModalRef.current.contains(event.target)
        ) {
          setIsCommentModalOpen(false);
        }
      };
      document.addEventListener("mousedown", handleClickOutside);
      return () => {
        document.removeEventListener("mousedown", handleClickOutside);
      };
    }
  }, [isCommentModalOpen]);

    useEffect(() => {
            const storedToken = localStorage.getItem('token');
            if (!storedToken) {
              console.error("No token found in localStorage");
              setError("No token found. Please log in again.");
              return;
            }
          
            try {
              const decoded = jwtDecode(storedToken);
              if (isJwtExpired(decoded)) {
                localStorage.removeItem('token');
                setError('Session expired. Please sign in again.');
                return;
              }
              if (!decoded || !decoded.username) {
                console.error("Invalid token or missing username");
                setError("Invalid token. Please log in again.");
                return;
              }
              setUser(decoded);
              //console.log("Decoded User:", decoded); 
              const fetchRequests = async () => {
                try {
                  const response = await fetch(`/api/tickets/requests/${decoded.username}`, {
                    headers: { Authorization: `Bearer ${storedToken}` }
                  });
                  if (!response.ok) throw new Error("Failed to fetch requests");
                  const data = await response.json();
                  setRequests(data);
                } catch (error) {
                  console.error("Error fetching requests:", error);
                  setError("Failed to fetch requests. Please try again later.");
                }
              };
              fetchRequests();
            } catch (error) {
              console.error("Failed to decode token:", error);
              setError("Failed to decode token. Please log in again.");
            }
          
    }, []);

    useEffect(() => {
        const fetchDepartments = async () => {
            try {
                const response = await fetch('/api/departments');
                if (!response.ok) throw new Error("Failed to fetch departments");
                const data = await response.json();
                setDepartments(data);
            } catch (error) {
                console.error("Error fetching departments:", error);
            }
        };

        fetchDepartments();
    }, []);

    const resetRequestForm = () => {
        setTitle('');
        setDescription('');
        setPhoneNumber('');
        setPhoneKind(PHONE_KIND_MOBILE);
        setDepartment('');
        setStatus('pending');
    };

    const handleCreateNewRequest = async () => {
        if (!title || !description || !isPhoneFormValid(phoneKind, phoneNumber)) return;
        try {
            const newRequestData = {
                title,
                description,
                ...buildPhoneApiBody(phoneKind, phoneNumber),
                department,
                createdBy: user.username,
                status: 'pending',
            };
            const response = await fetch('/api/tickets/requests', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${localStorage.getItem('token')}`
                },
                body: JSON.stringify(newRequestData),
            });
            if (!response.ok) throw new Error(`HTTP error! Status: ${response.status}`);
            const newRequest = await response.json();
            setRequests([...requests, newRequest]);
            resetRequestForm();
            setIsEditModalOpen(false);
            setSuccessMessage('New request created successfully!');
        } catch (error) {
            console.error("Create failed:", error);
            setError(`Error: ${error.message}. Check server status and URL.`);
        }
    };

    const handleUpdateRequest = async () => {
        if (!selectedRequest || !title || !description || !isPhoneFormValid(phoneKind, phoneNumber)) return;
        try {
            const updatedRequestData = {
                title,
                description,
                ...buildPhoneApiBody(phoneKind, phoneNumber),
                department,
                status
            };
            const response = await fetch(`/api/tickets/requests/${selectedRequest._id}`, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${localStorage.getItem('token')}`
                },
                body: JSON.stringify(updatedRequestData)
            });
            if (!response.ok) throw new Error("Failed to update request");
            const updatedRequest = await response.json();
            setRequests(requests.map(req => (req._id === selectedRequest._id ? updatedRequest : req)));
            setSelectedRequest(null);
            resetRequestForm();
            setIsEditModalOpen(false);
            setSuccessMessage('Request updated successfully!');
        } catch (error) {
            console.error("Update failed:", error);
            setError("Failed to update request. Please try again later.");
        }
    };
    const formatDate = (dateString) => {
        const date = new Date(dateString);
        return date.toLocaleDateString('en-GB', {
          day: 'numeric',
          month: 'numeric',
          year: 'numeric',
        });
      };

    const formatDateTime = (dateString) => {
        if (!dateString) return '';
        const date = new Date(dateString);
        if (Number.isNaN(date.getTime())) return '';
        return date.toLocaleString('en-GB', {
          day: '2-digit',
          month: '2-digit',
          year: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        });
      };


      const handleAddComment = async () => {
        if (!selectedRequest || !commentText) return;
        try {
            const commentData = {
                commentedBy: user.username,
                commentText
            };
            const response = await fetch(`/api/tickets/requests/${selectedRequest._id}/comments`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${localStorage.getItem('token')}`
                },
                body: JSON.stringify(commentData)
            });
            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
            const data = await response.json();
            setRequests(requests.map(req => (req._id === selectedRequest._id ? data : req)));
            setSelectedRequest(data);
            setCommentText('');
            setIsCommentModalOpen(false);
            setSuccessMessage('Comment added successfully!');
        } catch (error) {
            setError(`Error: ${error.message}. Check server status and URL.`);
        }
    };

    const handleDeleteRequest = async (requestId) => {
        try {
            const response = await fetch(`/api/tickets/requests/${requestId}`, {
                method: 'DELETE',
                headers: {
                    Authorization: `Bearer ${localStorage.getItem('token')}`
                }
            });
            if (!response.ok) throw new Error("Failed to delete request");
            
            setRequests(requests.filter(req => req._id !== requestId));
            setSuccessMessage('Request deleted successfully!');
        } catch (error) {
            console.error("Delete failed:", error);
            setError(`Error: ${error.message}. Check server status and URL.`);
        }
    };

    const toggleView = (view) => {
        setCurrentView(view);
    };

    const openRequests = useMemo(() => requests.filter(req => req.status === 'pending'), [requests]);
    const inProgressRequests = useMemo(() => requests.filter(req => req.status === 'in progress'), [requests]);
    const closedRequests = useMemo(() => requests.filter(req => req.status === 'closed'), [requests]);

    const visibleRequests = useMemo(() => {
      const list =
        currentView === 'pending'
          ? openRequests
          : currentView === 'in progress'
            ? inProgressRequests
            : closedRequests;
      return [...list].sort(
        (a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0),
      );
    }, [currentView, openRequests, inProgressRequests, closedRequests]);

    const filteredUserRequests = useMemo(() => {
      const q = myRequestsQuery.trim().toLowerCase();
      if (!q) return visibleRequests;
      return visibleRequests.filter((r) => {
        const hay = [
          r.title,
          r.description,
          r.assignedTo,
          r.assignedToDisplayName,
          r.department,
          r.status,
          r.createdBy,
          r.createdByDisplayName,
        ]
          .map((x) => String(x || '').toLowerCase())
          .join(' ');
        return hay.includes(q);
      });
    }, [visibleRequests, myRequestsQuery]);

    const myRequestStats = useMemo(
      () => ({
        shown: filteredUserRequests.length,
        inTab: visibleRequests.length,
      }),
      [filteredUserRequests.length, visibleRequests.length],
    );

    const viewPageMeta = {
      pending: {
        title: 'Pending',
        subtitle: 'Requests waiting to be picked up.',
        empty: 'No pending requests.',
      },
      'in progress': {
        title: 'In progress',
        subtitle: 'Work in progress on your cases.',
        empty: 'No in progress requests.',
      },
      closed: {
        title: 'Closed',
        subtitle: 'Completed or closed requests.',
        empty: 'No closed requests.',
      },
    };
    const vm = viewPageMeta[currentView] || viewPageMeta.pending;

    const descPreview = (d) => {
      const t = String(d || '');
      return t.length > 100 ? `${t.slice(0, 100)}…` : t;
    };

    return (
      <div className="admin-dashboard user-requests-page">
        <aside className="admin-sidebar" aria-label="Request views">
          <div className="admin-sidebar-head">
            <span className="admin-sidebar-kicker">Support Center</span>
            <strong className="admin-sidebar-title">My requests</strong>
          </div>
          <nav className="admin-nav">
            <div className="admin-nav-group">
              <span className="admin-nav-group-label">Status</span>
              <button
                type="button"
                className={`admin-nav-item ${currentView === 'pending' ? 'admin-nav-item--active' : ''}`}
                onClick={() => toggleView('pending')}
              >
                <span>Pending</span>
                <span className="admin-nav-item__count" aria-label={`${openRequests.length} in pending`}>
                  {openRequests.length}
                </span>
              </button>
              <button
                type="button"
                className={`admin-nav-item ${currentView === 'in progress' ? 'admin-nav-item--active' : ''}`}
                onClick={() => toggleView('in progress')}
              >
                <span>In progress</span>
                <span className="admin-nav-item__count" aria-label={`${inProgressRequests.length} in progress`}>
                  {inProgressRequests.length}
                </span>
              </button>
              <button
                type="button"
                className={`admin-nav-item ${currentView === 'closed' ? 'admin-nav-item--active' : ''}`}
                onClick={() => toggleView('closed')}
              >
                <span>Closed</span>
                <span className="admin-nav-item__count" aria-label={`${closedRequests.length} closed`}>
                  {closedRequests.length}
                </span>
              </button>
            </div>
          </nav>
        </aside>

        <main className="admin-main">
          <header className="admin-main-header">
            <h1 className="admin-page-title">
              {userDisplayName(user)} — {vm.title}
            </h1>
            {vm.subtitle ? <p className="admin-page-subtitle">{vm.subtitle}</p> : null}
          </header>

          {(error || successMessage) && (
            <div className="admin-alerts" role="region" aria-label="Status messages">
              {error && (
                <div className="admin-alert admin-alert--error" role="alert">
                  {error}
                </div>
              )}
              {successMessage && (
                <div className="admin-alert admin-alert--success" role="status">
                  {successMessage}
                </div>
              )}
            </div>
          )}

          <div className="row mb-4">
            <div className="col-md-12">
              <div className="card admin-surface">
                <div className="card-header admin-card-header">
                  <h3 className="title admin-card-title">Ticket list</h3>
                  <div className="admin-toolbar">
                    <input
                      type="search"
                      className="form-control form-control-sm admin-search-input"
                      value={myRequestsQuery}
                      onChange={(e) => setMyRequestsQuery(e.target.value)}
                      placeholder="Search title, description, assignee…"
                      aria-label="Search my tickets"
                    />
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm admin-btn-ghost"
                      onClick={() => {
                        setSelectedRequest(null);
                        resetRequestForm();
                        setIsEditModalOpen(true);
                        setCommentText('');
                      }}
                    >
                      New request
                    </button>
                  </div>
                </div>
                <div className="card-body">
                  <div className="admin-requests-summary">
                    <span>{myRequestStats.shown} shown</span>
                    <span>{myRequestStats.inTab} in {vm.title.toLowerCase()}</span>
                  </div>
                  <div className="table-header">
                    <table className="admin-users-table">
                      <thead>
                        <tr>
                          <th>Title</th>
                          <th>Status</th>
                          <th>Department</th>
                          <th>Assigned To</th>
                          <th>Date</th>
                          <th>Created By</th>
                          <th>Actions</th>
                        </tr>
                      </thead>
                    </table>
                  </div>
                  <div className="table-body">
                    <table className="admin-users-table">
                      <tbody>
                        {filteredUserRequests.length === 0 ? (
                          <tr>
                            <td colSpan={7} className="admin-empty-row">
                              {visibleRequests.length === 0 ? vm.empty : 'No tickets match your search.'}
                            </td>
                          </tr>
                        ) : (
                          filteredUserRequests.map((request) => (
                            <tr
                              key={request._id}
                              className="admin-user-row"
                              onClick={() => {
                                setSelectedRequest(request);
                                setTitle(request.title);
                                setDescription(request.description);
                                setDepartment(request.department || '');
                                setStatus(request.status);
                                setIsViewModalOpen(true);
                                setCommentText('');
                              }}
                            >
                              <td>
                                <div className="admin-ticket-row-title">{request.title}</div>
                                <div className="admin-ticket-row-meta">{formatCreatorPreviewLine(request)}</div>
                                <div className="admin-ticket-row-meta admin-ticket-row-meta--muted">
                                  {descPreview(request.description)}
                                </div>
                              </td>
                              <td>
                                <span className={`admin-status-pill ${userTicketStatusClass(request.status)}`}>
                                  {request.status}
                                </span>
                              </td>
                              <td>{request.department || '—'}</td>
                              <td title={request.assignedTo || ''}>
                                {request.assignedToDisplayName || request.assignedTo || '—'}
                              </td>
                              <td>{formatDate(request.createdAt)}</td>
                              <td title={formatCreatorTooltip(request)}>
                                {formatCreatorTableCell(request)}
                              </td>
                              <td onClick={(e) => e.stopPropagation()}>
                                <div className="admin-ticket-actions">
                                  {currentView === 'pending' ? (
                                    <>
                                      <span
                                        className="action-icon admin-action-icon"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          setSelectedRequest(request);
                                          setTitle(request.title);
                                          setDescription(request.description);
                                          const st = formStateFromTicket(request);
                                          setPhoneKind(st.phoneKind);
                                          setPhoneNumber(st.phoneNumber);
                                          setDepartment(request.department || '');
                                          setStatus(request.status);
                                          setIsEditModalOpen(true);
                                          setCommentText('');
                                        }}
                                        role="img"
                                        aria-label="Edit"
                                        title="Edit request"
                                      >
                                        ✏️
                                      </span>
                                      <span
                                        className="action-icon admin-action-icon"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          setSelectedRequest(request);
                                          setTitle(request.title);
                                          setDescription(request.description);
                                          setDepartment(request.department || '');
                                          setStatus(request.status);
                                          setIsCommentModalOpen(true);
                                          setCommentText('');
                                        }}
                                        role="img"
                                        aria-label="Add comment"
                                        title="Add comment"
                                      >
                                        💬
                                      </span>
                                      <span
                                        className="action-icon admin-action-icon"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          if (window.confirm('Delete this request?')) {
                                            handleDeleteRequest(request._id);
                                          }
                                        }}
                                        role="img"
                                        aria-label="Delete"
                                        title="Delete request"
                                      >
                                        ❌
                                      </span>
                                    </>
                                  ) : (
                                    <span
                                      className="action-icon admin-action-icon"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        setSelectedRequest(request);
                                        setTitle(request.title);
                                        setDescription(request.description);
                                        setDepartment(request.department || '');
                                        setStatus(request.status);
                                        setIsCommentModalOpen(true);
                                        setCommentText('');
                                      }}
                                      role="img"
                                      aria-label="Add comment"
                                      title="Add comment"
                                    >
                                      💬
                                    </span>
                                  )}
                                </div>
                              </td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </main>

        {isViewModalOpen && (
                <div className="modal-overlay">
                    <div className="modal-content" ref={viewModalRef}>
                        <h3 className="modal-title">View Request</h3>
                        <form className="view-form" onSubmit={(e) => e.preventDefault()}>
                            <div className="form-group">
                                <label>Title: <strong>{title}</strong></label>
                                
                            </div>
                            <div className="form-group">
          <label>Description:</label>
          <textarea
            rows="4"
            className="form-control"
            value={description} 
          disabled 
          />
                
                                
                            </div>
                            <div className="form-group">
                                <label>Status: <strong>{status}</strong></label>
                                
                            </div>
                            <div className="form-group">
                                <label>
                                    Opened at:{' '}
                                    <strong>{formatDateTime(selectedRequest?.createdAt) || '—'}</strong>
                                </label>
                            </div>
                            {String(selectedRequest?.status || '').toLowerCase() === 'closed' && selectedRequest?.closedAt ? (
                              <>
                                <div className="form-group">
                                  <label>
                                    Closed by:{' '}
                                    <strong title={selectedRequest?.closedBy || ''}>
                                      {selectedRequest?.closedByDisplayName || selectedRequest?.closedBy || 'Unknown'}
                                    </strong>
                                  </label>
                                </div>
                                <div className="form-group">
                                  <label>Closed at: <strong>{formatDateTime(selectedRequest.closedAt)}</strong></label>
                                </div>
                              </>
                            ) : null}
                            <div className="form-group">
                                <label>Phone: <strong>{displayPhoneFromTicket(selectedRequest) || 'Not provided'}</strong></label>
                            </div>
                            <div className="form-group">
                                <label>Department: <strong>{selectedRequest?.department || 'Not selected'}</strong></label>
                            </div>
                            <div className="form-group">
                                <label>
                                  Requester:{' '}
                                  <strong title={formatCreatorTooltip(selectedRequest)}>
                                    {formatCreatorTableCell(selectedRequest)}
                                  </strong>
                                </label>
                                <div className="admin-ticket-row-meta admin-ticket-row-meta--muted">
                                  {formatCreatorPreviewLine(selectedRequest)}
                                </div>
                            </div>
                            <div className="form-group">
            <label>Comments:</label>                       
        </div>
        <div className="form-group">
        
        <ul className="comment-list">
  {selectedRequest?.comments?.map(comment => (
    <li className="comment-text" key={comment.commentDate} style={{ whiteSpace: "normal" }}>
      {comment.commentedByDisplayName || comment.commentedBy}: {formatDate(comment.commentDate)}  
      <textarea
        rows="1"
        className="form-control"
        value={` ${comment.commentText}`}
        disabled 
      />
    </li>
  ))}
</ul>
</div>
                            <div className="button-container">
                                <button
                                    type="button"
                                    className="btn btn-secondary"
                                    onClick={() => setIsViewModalOpen(false)}
                                >
                                    Close
                                </button>
                            </div>
                        </form>
                        
                    </div>
                </div>
            )}
            {/* Edit Modal */}
            {isEditModalOpen && (
                <div className="modal-overlay">
                    <div className="modal-content" ref={editModalRef}>
                        <h3 className="modal-title">{selectedRequest ? 'Edit Request' : 'New Request'}</h3>
                        <form onSubmit={(e) => e.preventDefault()}>
                            <div className="form-group">
                                <label>Title: </label>
                                <input
                                    type="text"
                                    className="form-control"
                                    value={title}
                                    onChange={(e) => setTitle(e.target.value)}
                                    required
                                />
                            </div>
                            <div className="form-group">
                                <label>Description:</label>
                                <textarea
                                    rows="4"
                                    className="form-control"
                                    value={description}
                                    onChange={(e) => setDescription(e.target.value)}
                                    required
                                />
                            </div>
                            <div className="form-group">
                                <label>Phone type</label>
                                <select
                                    className="form-control"
                                    value={phoneKind}
                                    onChange={(e) => {
                                      setPhoneKind(e.target.value);
                                      setPhoneNumber('');
                                    }}
                                >
                                    <option value={PHONE_KIND_MOBILE}>Mobile — 10 digits starting with 05</option>
                                    <option value={PHONE_KIND_INTERNAL}>Internal — 4 or 7 digits</option>
                                </select>
                            </div>
                            <div className="form-group">
                                <label>
                                  {phoneKind === PHONE_KIND_MOBILE
                                    ? 'Mobile number'
                                    : 'Extension (4 or 7 digits)'}
                                </label>
                                {phoneKind === PHONE_KIND_INTERNAL ? (
                                  <input
                                    type="text"
                                    className="form-control"
                                    style={{ maxWidth: '200px' }}
                                    inputMode="numeric"
                                    autoComplete="off"
                                    maxLength={7}
                                    value={phoneNumber}
                                    onChange={(e) =>
                                      setPhoneNumber(e.target.value.replace(/\D/g, '').slice(0, 7))
                                    }
                                    placeholder="0000 or 0000000"
                                  />
                                ) : (
                                  <input
                                    type="text"
                                    className="form-control"
                                    inputMode="numeric"
                                    autoComplete="off"
                                    maxLength={10}
                                    placeholder="0501234567"
                                    value={phoneNumber}
                                    onChange={(e) =>
                                      setPhoneNumber(e.target.value.replace(/\D/g, '').slice(0, 10))
                                    }
                                  />
                                )}
                                <small>
                                  {phoneKind === PHONE_KIND_MOBILE
                                    ? 'Exactly 10 digits, must start with 05.'
                                    : 'Exactly 4 or 7 digits (internal extension).'}
                                </small>
                            </div>
                            <div className="form-group">
                                <label>Department:</label>
                                <select
                                    className="form-control"
                                    value={department}
                                    onChange={(e) => setDepartment(e.target.value)}
                                >
                                    <option value="">Select department</option>
                                    {departments.map((item) => (
                                        <option key={item._id} value={item.name}>
                                            {item.name}
                                        </option>
                                    ))}
                                </select>
                            </div>
                         
                            
                            <div className="button-container">
                                <button
                                    type="button"
                                    className="btn btn-secondary"
                                    onClick={() => setIsEditModalOpen(false)}
                                >
                                    Cancel
                                </button>
                                <button
                                    type="button"
                                    className="btn btn-primary"
                                    onClick={selectedRequest ? handleUpdateRequest : handleCreateNewRequest}
                                    disabled={!title || !description || !isPhoneFormValid(phoneKind, phoneNumber)}
                                >
                                    {selectedRequest ? 'Save Changes' : 'Create Request'}
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            )}
            {/* Comment Modal */}
            {isCommentModalOpen && (
                <div className="modal-overlay">
                    <div className="modal-content" ref={commentModalRef}>
                        <h3 className="modal-title">Add Comment</h3>
                        <form onSubmit={(e) => e.preventDefault()}>
                            <div className="form-group">
                                <label>Title: <strong>{title}</strong></label>
                               
                            </div>
                            <div className="form-group">
                                <label>Request summary:</label>
                                <p className="admin-request-summary">
                                    {String(description || '').trim() || 'No description provided.'}
                                </p>
                            </div>
                            <div className="form-group">
                                <label>Comment:</label>
                                <textarea
                                    rows="4"
                                    className="form-control"
                                    value={commentText}
                                    onChange={(e) => setCommentText(e.target.value)}
                                    required
                                />
                            </div>
                            <div className="button-container">
                            <button
                                    type="button"
                                    className="btn btn-secondary"
                                    onClick={() => setIsCommentModalOpen(false)}
                                >
                                    Cancel
                                </button>
                                <button
                                    type="button"
                                    className="btn btn-primary"
                                    onClick={handleAddComment}
                                    disabled={!commentText}
                                >
                                    Add Comment
                                </button>
                                
                            </div>
                        </form>
                    </div>
                </div>
            )}

        </div>
    );
};

export default UserDashboard;